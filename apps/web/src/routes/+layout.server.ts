import { env } from 'cloudflare:workers';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const user = locals.user;
	// Invitations waiting for an answer, shown as a count next to "brians" in the nav.
	const invites = user?.username
		? ((await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?').bind(user.id).first<number>('n')) ?? 0)
		: 0;
	return { user, invites };
};
