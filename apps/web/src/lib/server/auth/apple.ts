import { sha256Hex } from '@brian/shared';
import type { LoginProvider } from './types.ts';

const APPLE = 'https://appleid.apple.com';

export const apple: LoginProvider = {
	id: 'apple',
	label: 'Apple',
	origin: APPLE,
	callback: 'POST',
	enabled: (env) => Boolean(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),

	async authUrl(env, redirectUri, { state, verifier }) {
		const url = new URL(`${APPLE}/auth/authorize`);
		url.search = new URLSearchParams({
			client_id: env.APPLE_CLIENT_ID,
			redirect_uri: redirectUri,
			response_type: 'code',
			// Requesting name or email makes Apple use form_post.
			response_mode: 'form_post',
			scope: 'name email',
			state,
			// Apple has no PKCE; the nonce binds the id_token to this browser's login instead.
			nonce: await sha256Hex(verifier)
		}).toString();
		return url.toString();
	},

	async profile(env, redirectUri, { code, verifier, form }) {
		const tokens = await fetch(`${APPLE}/auth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: env.APPLE_CLIENT_ID,
				client_secret: await clientSecret(env),
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
				code
			})
		});
		if (!tokens.ok) throw new Error(`Apple token exchange failed: ${tokens.status}`);
		const { id_token } = (await tokens.json()) as { id_token: string };

		// The id_token came straight from Apple's token endpoint over TLS, authenticated with our
		// client secret, so per OpenID Connect Core 3.1.3.7 we check its claims instead of its signature.
		const claims = JSON.parse(base64urlDecode(id_token.split('.')[1])) as {
			iss: string;
			aud: string;
			exp: number;
			sub: string;
			nonce?: string;
			email?: string;
			email_verified?: boolean | 'true' | 'false';
		};
		if (claims.iss !== APPLE || claims.aud !== env.APPLE_CLIENT_ID || claims.exp * 1000 < Date.now()) {
			throw new Error('Apple id_token is not for this app');
		}
		if (claims.nonce !== (await sha256Hex(verifier))) throw new Error('Apple id_token nonce mismatch');
		if (!claims.email || String(claims.email_verified) !== 'true') throw new Error('Apple account has no verified email');

		return { provider: 'apple', providerUserId: claims.sub, email: claims.email, name: appleName(form) };
	}
};

/** Apple's client secret is a short-lived ES256 JWT signed with the .p8 key. */
async function clientSecret(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'ES256', kid: env.APPLE_KEY_ID };
	const payload = { iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: APPLE, sub: env.APPLE_CLIENT_ID };
	const input = `${base64urlJson(header)}.${base64urlJson(payload)}`;

	const pem = env.APPLE_PRIVATE_KEY.replace(/-----[^-]+-----|\s/g, '');
	const key = await crypto.subtle.importKey(
		'pkcs8',
		Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
	return `${input}.${base64url(new Uint8Array(signature))}`;
}

function appleName(form?: FormData): string | null {
	try {
		const user = JSON.parse(String(form?.get('user') ?? '')) as { name?: { firstName?: string; lastName?: string } };
		return [user.name?.firstName, user.name?.lastName].filter(Boolean).join(' ') || null;
	} catch {
		return null;
	}
}

const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const base64urlJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
const base64urlDecode = (value: string) =>
	new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
