import { error, redirect } from '@sveltejs/kit';
import { randomToken, safeNext } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { findProvider, LOGIN_COOKIE } from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const provider = findProvider(env, params.provider);
	if (!provider) error(404, 'Unknown login method');

	const state = randomToken();
	const verifier = randomToken();
	const next = safeNext(url.searchParams.get('next'));
	cookies.set(LOGIN_COOKIE, JSON.stringify({ state, verifier, next }), {
		// __Host- cookies must be Secure with Path=/, so dev.mybrian.dev can never set or shadow them.
		path: '/',
		secure: true,
		httpOnly: true,
		// Apple posts the callback from its own site, and browsers only send SameSite=None cookies on that.
		sameSite: provider.callback === 'POST' ? 'none' : 'lax',
		maxAge: 10 * 60
	});

	const redirectUri = `${url.origin}/login/${provider.id}/callback`;
	redirect(302, await provider.authUrl(env, redirectUri, { state, verifier }), { external: [provider.origin] });
};
