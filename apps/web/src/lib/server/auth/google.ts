import { pkceChallenge } from '@brian/shared';
import type { LoginProvider } from './types.ts';

export const google: LoginProvider = {
	id: 'google',
	label: 'Google',
	origin: 'https://accounts.google.com',
	callback: 'GET',
	enabled: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),

	async authUrl(env, redirectUri, { state, verifier }) {
		const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
		url.search = new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: 'openid email profile',
			state,
			code_challenge: await pkceChallenge(verifier),
			code_challenge_method: 'S256',
			prompt: 'select_account'
		}).toString();
		return url.toString();
	},

	async profile(env, redirectUri, { code, verifier }) {
		const tokens = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier
			})
		});
		if (!tokens.ok) throw new Error(`Google token exchange failed: ${tokens.status}`);
		const { access_token } = (await tokens.json()) as { access_token: string };

		const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: { Authorization: `Bearer ${access_token}` }
		});
		if (!response.ok) throw new Error(`Google userinfo failed: ${response.status}`);
		const user = (await response.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string };
		if (!user.email || user.email_verified !== true) throw new Error('Google account has no verified email');

		return { provider: 'google', providerUserId: user.sub, email: user.email, name: user.name ?? null };
	}
};
