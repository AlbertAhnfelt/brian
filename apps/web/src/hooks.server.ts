import type { Handle } from '@sveltejs/kit/hooks';
import { getSessionUser, SESSION_COOKIE } from '@brian/shared';
import { env } from 'cloudflare:workers';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSessionUser(env.DB, event.cookies.get(SESSION_COOKIE));
	return resolve(event);
};
