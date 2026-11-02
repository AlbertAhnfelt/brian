import { redirect } from '@sveltejs/kit';
import { deleteSession, SESSION_COOKIE } from '@brian/shared';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) await deleteSession(env.DB, token);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/');
};
