import { error } from '@sveltejs/kit';
import { READER_QUERY_LENGTH } from '@brian/shared';
import { account } from '#lib/server/account.ts';
import { readerHref } from '#lib/reader.ts';
import { renderMarkdown } from './markdown.ts';

/**
 * One screen of the reader: the tree down to `path`, the page rendered if it's a page, and search
 * results for ?q=. `userId` null is someone not signed in; `brianId` null is the user's own Brian.
 * The server decides what this reader may see; anything else is a 404.
 */
export async function loadReader(userId: string | null, brianId: string | null, path: string, url: URL, base: string) {
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, READER_QUERY_LENGTH);
	const [view, hits] = await Promise.all([
		account().readView(userId, brianId, path),
		q ? account().readSearch(userId, brianId, q) : Promise.resolve(null)
	]);
	if (!view) error(404, 'Nothing here.');
	// Only the rendered page goes to the browser, not its markdown.
	const page = view.page && {
		path: view.page.path,
		updatedAt: view.page.updatedAt,
		...renderMarkdown(view.page.content, { path: view.page.path, links: view.page.links, href: (p) => readerHref(base, p) })
	};
	return { base, shelf: view.shelf, tree: view.tree, folder: view.folder, page, q, hits };
}
