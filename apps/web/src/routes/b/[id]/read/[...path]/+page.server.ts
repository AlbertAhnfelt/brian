import { loadReader } from '#lib/server/reader.ts';
import type { PageServerLoad } from './$types';

/**
 * One shared brian, read-only: for its members, and for anyone at all when it's public, signed in
 * or not. The server decides; a private brian is a 404 to everyone else.
 */
export const load: PageServerLoad = async ({ locals, params, url, setHeaders }) => {
	const data = await loadReader(locals.user?.id ?? null, params.id, params.path, url, `/b/${encodeURIComponent(params.id)}/read`);
	// Only public brians reach someone signed out, so only those are cached, briefly.
	setHeaders(locals.user ? { 'cache-control': 'private, no-store' } : { 'cache-control': 'public, max-age=60', vary: 'Cookie' });
	return { ...data, signedIn: !!locals.user };
};
