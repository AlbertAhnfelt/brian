import { READER_MARK_END, READER_MARK_START } from '@brian/shared';

/** The reader's URL for a page or folder: `base` ("/notes", "/b/<id>/read") plus the path, each part encoded. */
export function readerHref(base: string, path: string): string {
	const parts = path.split('/').filter(Boolean).map(encodeURIComponent);
	return parts.length ? `${base}/${parts.join('/')}` : base;
}

/** The last part of a path, without a trailing "/" or ".md": "notes/Idea.md" → "Idea". */
export function displayName(path: string): string {
	const name = path.replace(/\/$/, '').split('/').pop() ?? '';
	return name.replace(/\.md$/i, '');
}

/** An anchor for a heading, the same for the heading itself and for [[Page#Heading]] links to it. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
}

/** A search snippet as text and matches, from the markers search puts around matches. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
	const parts: { text: string; match: boolean }[] = [];
	for (const piece of snippet.split(READER_MARK_START)) {
		const end = piece.indexOf(READER_MARK_END);
		if (end < 0) parts.push({ text: piece, match: false });
		else parts.push({ text: piece.slice(0, end), match: true }, { text: piece.slice(end + 1), match: false });
	}
	return parts.filter((part) => part.text);
}
