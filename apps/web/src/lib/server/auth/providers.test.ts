import { pkceChallenge, sha256Hex } from '@brian/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apple } from './apple.ts';
import { github } from './github.ts';
import { google } from './google.ts';

const REDIRECT = 'https://dev.mybrian.dev/login/x/callback';
const verifier = 'v'.repeat(43);

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers fetch calls by URL prefix and records them. */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
		if (!route) throw new Error(`Unexpected fetch ${url}`);
		return routes[route](init);
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

const env = {
	GOOGLE_CLIENT_ID: 'g-id',
	GOOGLE_CLIENT_SECRET: 'g-secret',
	GITHUB_CLIENT_ID: 'gh-id',
	GITHUB_CLIENT_SECRET: 'gh-secret',
	APPLE_CLIENT_ID: 'dev.mybrian.web',
	APPLE_TEAM_ID: 'TEAM123',
	APPLE_KEY_ID: 'KEY123',
	APPLE_PRIVATE_KEY: ''
} as Env;

describe('google', () => {
	it('builds an auth URL with PKCE and state', async () => {
		const url = new URL(await google.authUrl(env, REDIRECT, { state: 's1', verifier }));
		expect(url.origin).toBe(google.origin);
		expect(url.searchParams.get('state')).toBe('s1');
		expect(url.searchParams.get('code_challenge')).toBe(await pkceChallenge(verifier));
	});

	it('returns the verified profile', async () => {
		const calls = mockFetch({
			'https://oauth2.googleapis.com/token': () => json({ access_token: 'at' }),
			'https://openidconnect.googleapis.com': () => json({ sub: '1', email: 'a@gmail.com', email_verified: true, name: 'A' })
		});
		const profile = await google.profile(env, REDIRECT, { code: 'c', verifier });
		expect(profile).toEqual({ provider: 'google', providerUserId: '1', email: 'a@gmail.com', name: 'A' });
		expect(String(calls[0].init?.body)).toContain(`code_verifier=${verifier}`);
	});

	it('rejects unverified emails', async () => {
		mockFetch({
			'https://oauth2.googleapis.com/token': () => json({ access_token: 'at' }),
			'https://openidconnect.googleapis.com': () => json({ sub: '1', email: 'a@gmail.com', email_verified: false })
		});
		await expect(google.profile(env, REDIRECT, { code: 'c', verifier })).rejects.toThrow(/verified/);
	});
});

describe('github', () => {
	it('uses the primary verified email', async () => {
		mockFetch({
			'https://github.com/login/oauth/access_token': () => json({ access_token: 'at' }),
			'https://api.github.com/user/emails': () =>
				json([
					{ email: 'old@example.com', primary: false, verified: true },
					{ email: 'main@example.com', primary: true, verified: true }
				]),
			'https://api.github.com/user': () => json({ id: 42, login: 'octo', name: null })
		});
		const profile = await github.profile(env, REDIRECT, { code: 'c', verifier });
		expect(profile).toEqual({ provider: 'github', providerUserId: '42', email: 'main@example.com', name: 'octo' });
	});

	it('rejects accounts whose primary email is unverified', async () => {
		mockFetch({
			'https://github.com/login/oauth/access_token': () => json({ access_token: 'at' }),
			'https://api.github.com/user/emails': () => json([{ email: 'x@example.com', primary: true, verified: false }]),
			'https://api.github.com/user': () => json({ id: 42, login: 'octo', name: null })
		});
		await expect(github.profile(env, REDIRECT, { code: 'c', verifier })).rejects.toThrow(/verified/);
	});

	it('reports a failed code exchange (GitHub answers 200 with an error)', async () => {
		mockFetch({ 'https://github.com/login/oauth/access_token': () => json({ error: 'bad_verification_code' }) });
		await expect(github.profile(env, REDIRECT, { code: 'c', verifier })).rejects.toThrow(/bad_verification_code/);
	});
});

describe('apple', async () => {
	const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
	const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
	const appleEnv = { ...env, APPLE_PRIVATE_KEY: pem } as Env;

	const b64url = (value: unknown) =>
		btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
	const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
	const goodClaims = async () => ({
		iss: 'https://appleid.apple.com',
		aud: 'dev.mybrian.web',
		exp: Math.floor(Date.now() / 1000) + 600,
		sub: 'apple-user',
		nonce: await sha256Hex(verifier),
		email: 'x@privaterelay.appleid.com',
		email_verified: 'true'
	});

	it('asks for form_post with a nonce derived from the verifier', async () => {
		const url = new URL(await apple.authUrl(appleEnv, REDIRECT, { state: 's', verifier }));
		expect(url.searchParams.get('response_mode')).toBe('form_post');
		expect(url.searchParams.get('nonce')).toBe(await sha256Hex(verifier));
	});

	it('signs a valid ES256 client secret and reads the profile', async () => {
		let secret = '';
		const claims = await goodClaims();
		mockFetch({
			'https://appleid.apple.com/auth/token': (init) => {
				secret = new URLSearchParams(String(init?.body)).get('client_secret')!;
				return json({ id_token: idToken(claims) });
			}
		});
		const form = new FormData();
		form.set('user', JSON.stringify({ name: { firstName: 'Brian', lastName: 'Griffin' } }));
		const profile = await apple.profile(appleEnv, REDIRECT, { code: 'c', verifier, form });
		expect(profile).toEqual({ provider: 'apple', providerUserId: 'apple-user', email: claims.email, name: 'Brian Griffin' });

		const [header, payload, signature] = secret.split('.');
		expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY123' });
		expect(decode(payload)).toMatchObject({ iss: 'TEAM123', sub: 'dev.mybrian.web', aud: 'https://appleid.apple.com' });
		const raw = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
		const valid = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			keys.publicKey,
			raw,
			new TextEncoder().encode(`${header}.${payload}`)
		);
		expect(valid).toBe(true);
	});

	it.each([
		['wrong audience', { aud: 'someone.else' }],
		['wrong issuer', { iss: 'https://evil.example' }],
		['expired', { exp: 1 }],
		['wrong nonce', { nonce: 'replayed' }],
		['unverified email', { email_verified: 'false' }]
	])('rejects an id_token with %s', async (_, override) => {
		const claims = { ...(await goodClaims()), ...override };
		mockFetch({ 'https://appleid.apple.com/auth/token': () => json({ id_token: idToken(claims) }) });
		await expect(apple.profile(appleEnv, REDIRECT, { code: 'c', verifier })).rejects.toThrow();
	});
});
