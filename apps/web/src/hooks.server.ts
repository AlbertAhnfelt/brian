import type { Handle } from '@sveltejs/kit/hooks';
import { getSessionUser, loginAllowed, SESSION_COOKIE } from '@brian/shared';
import { env } from 'cloudflare:workers';

export const handle: Handle = async ({ event, resolve }) => {
	const user = await getSessionUser(env.DB, event.cookies.get(SESSION_COOKIE));
	// Re-checked on every request, so removing an email from the allowlist signs it out at once.
	event.locals.user = user && loginAllowed(env, user.email) ? user : null;
	return resolve(event);
};
