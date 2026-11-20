import type { Role, Visibility } from './brians';

/** Folders (ending in "/") and pages directly under one folder, as full paths. */
export interface ReaderListing {
	folders: string[];
	files: string[];
}

/** A page opened on the website, with where its [[wikilinks]] lead. */
export interface ReaderPage {
	path: string;
	content: string;
	updatedAt: number;
	/** Each [[link]] target on the page (as `wikilinkTargets` finds them) → the page's path, or null if there's none. */
	links: Record<string, string | null>;
}

/** What is being read: the signed-in user's whole Brian, or one shared brian on its own. */
export type ReaderShelf =
	| { kind: 'mine'; username: string }
	| {
			kind: 'brian';
			id: string;
			name: string;
			visibility: Visibility;
			/** The reader's role, or null for someone who isn't a member (a public brian). */
			role: Role | null;
	  };

/** One screen of the reader: the folder tree down to what's open, and the page if a page is open. */
export interface ReaderView {
	shelf: ReaderShelf;
	/** Listings of the root ("") and of every folder down to the open one, keyed by prefix ("notes/"). */
	tree: Record<string, ReaderListing>;
	/** The open folder's prefix ("" for the root). For a page, its folder. */
	folder: string;
	/** The open page, or null when a folder is open. */
	page: ReaderPage | null;
}

export interface ReaderHit {
	path: string;
	/** Matching text, each match between READER_MARK_START and READER_MARK_END. */
	snippet: string;
}

/** Around each match in a ReaderHit snippet. Control characters, so no page text looks like one. */
export const READER_MARK_START = '\u0002';
export const READER_MARK_END = '\u0003';

/** Longest search query the reader sends. */
export const READER_QUERY_LENGTH = 200;

/**
 * The targets of a page's [[wikilinks]] and ![[embeds]], without alias, heading or block parts:
 * "[[notes/Idea#Why|why]]" → "notes/Idea". Links to a heading on the same page ("[[#Why]]") are left out.
 */
export function wikilinkTargets(content: string): string[] {
	const found = new Set<string>();
	for (const match of content.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
		const target = wikilinkTarget(match[1]);
		if (target) found.add(target);
	}
	return [...found];
}

/** The page part of what's inside [[…]]: before any "|" alias and "#" heading or "^" block. */
export function wikilinkTarget(inner: string): string {
	return inner.split('|')[0].split('#')[0].split('^')[0].trim();
}
