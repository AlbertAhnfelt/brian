import { redirect } from '@sveltejs/kit';
import { loadReader } from '#lib/server/reader.ts';
import type { PageServerLoad } from './$types';

/** The signed-in user's whole Brian, shared brians included, read-only. Never public, never indexed. */
export const load: PageServerLoad = async ({ locals, params, url, setHeaders }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	setHeaders({ 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' });
	return loadReader(locals.user.id, null, params.path, url, '/notes');
};
