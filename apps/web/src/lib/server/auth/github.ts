import { pkceChallenge } from '@brian/shared';
import type { LoginProvider } from './types.ts';

const api = (token: string) => ({
	headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'brian' }
});

export const github: LoginProvider = {
	id: 'github',
	label: 'GitHub',
	origin: 'https://github.com',
	callback: 'GET',
	enabled: (env) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),

	async authUrl(env, redirectUri, { state, verifier }) {
		const url = new URL('https://github.com/login/oauth/authorize');
		url.search = new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: 'read:user user:email',
			state,
			code_challenge: await pkceChallenge(verifier),
			code_challenge_method: 'S256'
		}).toString();
		return url.toString();
	},

	async profile(env, redirectUri, { code, verifier }) {
		const tokens = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				redirect_uri: redirectUri,
				code,
				code_verifier: verifier
			})
		});
		// GitHub answers 200 with an `error` field when the exchange fails.
		const { access_token, error } = (await tokens.json()) as { access_token?: string; error?: string };
		if (!access_token) throw new Error(`GitHub token exchange failed: ${error ?? tokens.status}`);

		const [userResponse, emailsResponse] = await Promise.all([
			fetch('https://api.github.com/user', api(access_token)),
			fetch('https://api.github.com/user/emails', api(access_token))
		]);
		if (!userResponse.ok || !emailsResponse.ok) throw new Error('GitHub profile request failed');
		const user = (await userResponse.json()) as { id: number; login: string; name: string | null };
		const emails = (await emailsResponse.json()) as { email: string; primary: boolean; verified: boolean }[];
		const email = emails.find((e) => e.primary && e.verified)?.email;
		if (!email) throw new Error('GitHub account has no verified primary email');

		return { provider: 'github', providerUserId: String(user.id), email, name: user.name ?? user.login };
	}
};
