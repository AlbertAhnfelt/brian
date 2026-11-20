import type { Handle } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { getSessionUser, loginAllowed, SESSION_COOKIE } from '@brian/shared';
import { env } from 'cloudflare:workers';

/** Pages a signed-in user can open before choosing a username. */
const BEFORE_USERNAME = ['/', '/welcome', '/logout', '/about', '/privacy', '/terms', '/account', '/account/export'];

/** A 429 for people: plain words, and when to try again. */
const tooMany = (what: string) =>
	new Response(`Too many ${what}. Wait a minute and try again.`, {
		status: 429,
		headers: { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' }
	});

export const handle: Handle = async ({ event, resolve }) => {
	// Sign-in, per IP address: keeps scripts from hammering the login providers and account creation.
	if (event.url.pathname.startsWith('/login/')) {
		const ip = event.request.headers.get('CF-Connecting-IP') ?? 'unknown';
		if (!(await env.LOGIN_LIMITER.limit({ key: ip })).success) return tooMany('sign-in attempts');
	}

	const user = await getSessionUser(env.DB, event.cookies.get(SESSION_COOKIE));
	// Re-checked on every request, so removing an email from the allowlist signs it out at once.
	event.locals.user = user && loginAllowed(env, user.email) ? user : null;

	// Form posts (invites, new brians, usernames…), per user.
	if (event.locals.user && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		if (!(await env.ACTION_LIMITER.limit({ key: event.locals.user.id })).success) return tooMany('changes');
	}

	// The username names the user's brian, so everything else waits until it's chosen.
	const { pathname, search } = event.url;
	if (event.locals.user && !event.locals.user.username && !BEFORE_USERNAME.includes(pathname) && !pathname.startsWith('/login')) {
		redirect(303, `/welcome?next=${encodeURIComponent(pathname + search)}`);
	}
	return resolve(event);
};
