import { LIMITS, READER_MARK_END, READER_MARK_START, READER_QUERY_LENGTH, wikilinkTargets, type ReaderHit, type ReaderListing, type ReaderPage, type ReaderShelf, type ReaderView } from '@brian/shared';
import { foldPath, normalizePath, normalizePrefix, VaultError } from '../vault/paths';
import type { Page, SearchHit } from '../vault/vault';
import { readableBrian, type Bindings } from './members';
import { Brian } from './router';

/** Pages the website may show one reader, with paths as the reader sees them. Nothing here writes. */
interface Shelf {
	info: ReaderShelf;
	list(prefix: string): Promise<ReaderListing>;
	/** The page at `path`, or null if there's none. */
	read(path: string): Promise<Page | null>;
	search(query: string): Promise<SearchHit[]>;
	resolve(from: string, names: string[]): Promise<(string | null)[]>;
}

/**
 * What this reader may read: their own whole Brian (`brianId` null, signed in only), or one shared
 * brian they're a member of or that is public. Null otherwise, as if there were nothing there.
 */
async function shelfFor(env: Bindings, userId: string | null, brianId: string | null): Promise<Shelf | null> {
	if (brianId === null) {
		if (!userId) return null;
		const brian = await Brian.load(env, userId, 'website', { rules: false });
		if (!brian.username) return null;
		return {
			info: { kind: 'mine', username: brian.username },
			list: (prefix) => brian.list(prefix),
			read: (path) => brian.find(path),
			search: (query) => brian.search(query, LIMITS.searchResults, MARKS),
			resolve: (from, names) => brian.resolve(from, names)
		};
	}
	const brian = await readableBrian(env.DB, userId, brianId);
	if (!brian) return null;
	// The vault named by the ID readableBrian found in D1, never by the caller's input alone.
	const vault = env.VAULT.getByName(brian.id);
	return {
		info: { kind: 'brian', ...brian },
		list: async (prefix) => {
			const { folders, files } = await vault.list(prefix);
			return { folders, files };
		},
		read: async (path) => (await vault.readPages([path]))[0],
		search: (query) => vault.search(query, LIMITS.searchResults, MARKS),
		resolve: (_from, names) => vault.resolve(names)
	};
}

/** Around matches in search snippets: characters no page has, unlike markdown's **. */
const MARKS: [string, string] = [READER_MARK_START, READER_MARK_END];

/** "a/b/" → ["", "a/", "a/b/"]. */
function ancestors(folder: string): string[] {
	const parts = folder.split('/').slice(0, -1);
	return ['', ...parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/`)];
}

export async function readView(env: Bindings, userId: string | null, brianId: string | null, path: string): Promise<ReaderView | null> {
	const shelf = await shelfFor(env, userId, brianId);
	if (!shelf) return null;

	let pagePath: string | null;
	let folder: string;
	try {
		pagePath = /\.md$/i.test(path.trim()) ? normalizePath(path) : null;
		folder = normalizePrefix(pagePath ? pagePath.split('/').slice(0, -1).join('/') : path);
	} catch (error) {
		if (error instanceof VaultError) return null;
		throw error;
	}

	// Every folder down to the open one, and the page, all at once.
	const prefixes = ancestors(folder);
	const [found, ...listings] = await Promise.all([pagePath ? shelf.read(pagePath) : null, ...prefixes.map((prefix) => shelf.list(prefix))]);
	const here = listings.at(-1)!;
	if (pagePath ? !found : folder && !here.folders.length && !here.files.length) return null;

	// Keyed by each folder's own casing (as its parent lists it), whatever casing the URL used.
	const tree: Record<string, ReaderListing> = {};
	let key = '';
	prefixes.forEach((prefix, i) => {
		if (i > 0) key = listings[i - 1].folders.find((f) => foldPath(f) === foldPath(prefix)) ?? prefix;
		tree[key] = { folders: listings[i].folders, files: listings[i].files };
	});

	let page: ReaderPage | null = null;
	if (found) {
		const targets = wikilinkTargets(found.content).slice(0, 500);
		const resolved = targets.length ? await shelf.resolve(found.path, targets) : [];
		page = {
			path: found.path,
			content: found.content,
			updatedAt: found.updatedAt,
			links: Object.fromEntries(targets.map((target, i) => [target, resolved[i] ?? null]))
		};
	}
	return { shelf: shelf.info, tree, folder: key, page };
}

export async function readSearch(env: Bindings, userId: string | null, brianId: string | null, query: string): Promise<ReaderHit[] | null> {
	const shelf = await shelfFor(env, userId, brianId);
	if (!shelf) return null;
	const q = query.trim().slice(0, READER_QUERY_LENGTH);
	if (!q) return [];
	// Snippets are raw markdown: drop the syntax that reads as noise out of context.
	const plain = (snippet: string) => snippet.replace(/\[\[|\]\]|\*\*|__|==|%%/g, '').replace(/(^|\s)#{1,6}\s/g, '$1');
	return (await shelf.search(q)).map(({ path, snippet }) => ({ path, snippet: plain(snippet) }));
}
