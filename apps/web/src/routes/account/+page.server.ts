import { fail, redirect } from '@sveltejs/kit';
import { SESSION_COOKIE } from '@brian/shared';
import { env } from 'cloudflare:workers';
import { account } from '#lib/server/account.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/login?next=/account');
	const [logins, connections] = await Promise.all([
		env.DB.prepare('SELECT provider, email FROM accounts WHERE user_id = ? ORDER BY created_at')
			.bind(locals.user.id)
			.all<{ provider: string; email: string }>(),
		account().connections(locals.user.id)
	]);
	return { logins: logins.results, connections };
};

export const actions: Actions = {
	disconnect: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/login?next=/account');
		const grantId = String((await request.formData()).get('grantId') ?? '');
		if (!grantId) return fail(400, { message: 'Missing app.' });
		// revokeGrant is scoped to this user, so another user's grant ID does nothing.
		await account().disconnect(locals.user.id, grantId);
	},

	signOutEverywhere: async ({ locals, cookies }) => {
		if (!locals.user) redirect(303, '/login');
		await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(locals.user.id).run();
		cookies.delete(SESSION_COOKIE, { path: '/', secure: true });
		redirect(303, '/');
	},

	delete: async ({ locals, request, cookies }) => {
		if (!locals.user) redirect(303, '/login');
		const confirm = String((await request.formData()).get('confirm') ?? '').trim().toLowerCase();
		if (confirm !== locals.user.email.toLowerCase()) {
			return fail(400, { message: 'Type your email exactly to confirm.' });
		}
		await account().deleteAccount(locals.user.id);
		await env.DB.batch([
			env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(locals.user.id),
			env.DB.prepare('DELETE FROM accounts WHERE user_id = ?').bind(locals.user.id),
			env.DB.prepare('DELETE FROM users WHERE id = ?').bind(locals.user.id)
		]);
		cookies.delete(SESSION_COOKIE, { path: '/', secure: true });
		redirect(303, '/');
	}
};
