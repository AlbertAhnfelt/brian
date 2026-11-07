import type { Handle } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { getSessionUser, loginAllowed, SESSION_COOKIE } from '@brian/shared';
import { env } from 'cloudflare:workers';

/** Pages a signed-in user can open before choosing a username. */
const BEFORE_USERNAME = ['/', '/welcome', '/logout', '/about', '/privacy', '/terms', '/account', '/account/export'];

export const handle: Handle = async ({ event, resolve }) => {
	const user = await getSessionUser(env.DB, event.cookies.get(SESSION_COOKIE));
	// Re-checked on every request, so removing an email from the allowlist signs it out at once.
	event.locals.user = user && loginAllowed(env, user.email) ? user : null;

	// The username names the user's brian, so everything else waits until it's chosen.
	const { pathname, search } = event.url;
	if (event.locals.user && !event.locals.user.username && !BEFORE_USERNAME.includes(pathname) && !pathname.startsWith('/login')) {
		redirect(303, `/welcome?next=${encodeURIComponent(pathname + search)}`);
	}
	return resolve(event);
};
