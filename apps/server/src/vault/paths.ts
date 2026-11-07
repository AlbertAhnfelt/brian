export const MAX_PATH_LENGTH = 512;
export const MAX_PAGE_BYTES = 1024 * 1024;
/** Pages per vault. Also keeps exports, which are built in memory, a manageable size. */
export const MAX_PAGES = 10_000;

export class VaultError extends Error {}

/**
 * Normalizes a page path ("notes/today.md"): no leading slash, no empty, "." or ".." segments.
 * Throws VaultError for paths that can't be stored.
 */
export function normalizePath(input: string): string {
	const path = input.trim().replace(/^\/+/, '');
	const segments = path.split('/');
	if (!path || path.endsWith('/')) throw new VaultError(`"${input}" is not a page path.`);
	if (path.length > MAX_PATH_LENGTH) throw new VaultError(`Paths can be at most ${MAX_PATH_LENGTH} characters.`);
	if (segments.some((s) => s === '' || s === '.' || s === '..')) {
		throw new VaultError(`"${input}" has an empty, "." or ".." segment.`);
	}
	if (/[\u0000-\u001f\u007f]/.test(path)) throw new VaultError('Paths cannot contain control characters.');
	// Unsafe in exported zips ("\" and ":" are separators/drives on Windows) or visually deceptive.
	if (/[\\:]|\p{Cf}|[\u2215\u2044\uff0f]/u.test(path)) {
		throw new VaultError('Paths cannot contain \\, :, slash look-alikes or invisible formatting characters.');
	}
	return path;
}

/** Throws unless `path` names a markdown page. Brian stores and syncs .md files only. */
export function checkMarkdown(path: string): void {
	if (!/[^/]\.md$/i.test(path)) throw new VaultError(`"${path}" is not a markdown page. Page paths must end in .md.`);
}

/** Normalizes a folder prefix for list(): "" for the root, otherwise ending in "/". */
export function normalizePrefix(input = ''): string {
	const prefix = input.trim().replace(/^\/+/, '').replace(/\/*$/, '');
	return prefix ? `${normalizePath(prefix)}/` : '';
}

/** Throws if `content` (grown by `extraChars`, for edits not yet applied) is over the page limit. */
export function checkSize(content: string, extraChars = 0): void {
	// Cheap upper bound first (a UTF-16 unit is at most 3 UTF-8 bytes), so huge results are never built.
	if (content.length + extraChars > MAX_PAGE_BYTES) {
		throw new VaultError(`Pages can be at most ${MAX_PAGE_BYTES / 1024} KB.`);
	}
	if (extraChars === 0 && new TextEncoder().encode(content).length > MAX_PAGE_BYTES) {
		throw new VaultError(`Pages can be at most ${MAX_PAGE_BYTES / 1024} KB.`);
	}
}

/**
 * Turns free text into a safe FTS5 query: each word becomes a quoted term, all must match.
 * A trailing "*" on a word keeps prefix matching ("proj*").
 */
export function ftsQuery(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => {
			const prefix = word.endsWith('*') && word.length > 1;
			const term = (prefix ? word.slice(0, -1) : word).replace(/"/g, '""');
			return `"${term}"${prefix ? '*' : ''}`;
		})
		.join(' ');
}
