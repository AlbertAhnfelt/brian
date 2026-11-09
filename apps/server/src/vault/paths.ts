import { LIMITS } from '@brian/shared';
import { pathProblem, repairPath as repairSegments } from '@brian/sync';

export class VaultError extends Error {}

/**
 * Normalizes a page path ("notes/today.md"): no leading slash, no empty, "." or ".." segments.
 * Throws VaultError for paths that can't be stored.
 */
export function normalizePath(input: string): string {
	// NFC: "\u00e5" typed on a Mac (often decomposed) and elsewhere must be the same page.
	const path = input.trim().replace(/^\/+/, '').normalize('NFC');
	const segments = path.split('/');
	if (!path || path.endsWith('/')) throw new VaultError(`"${input}" is not a page path.`);
	if (path.length > LIMITS.pathLength) throw new VaultError(`Paths can be at most ${LIMITS.pathLength} characters.`);
	if (segments.some((s) => s === '' || s === '.' || s === '..')) {
		throw new VaultError(`"${input}" has an empty, "." or ".." segment.`);
	}
	const problem = pathProblem(path);
	if (problem) throw new VaultError(problem);
	return path;
}

export { foldPath, normalizeText, numbered } from '@brian/sync';

/**
 * The closest valid path to one stored before the current rules, for migrating old pages.
 * Never fails: whatever can't be repaired becomes a placeholder name.
 */
export function repairPath(path: string): string {
	const repaired = repairSegments(path)?.slice(0, LIMITS.pathLength);
	try {
		return normalizePath(repaired ?? '');
	} catch {
		return 'untitled.md';
	}
}

/** Throws unless `path` names a markdown page. Brian stores and syncs .md files only. */
export function checkMarkdown(path: string): void {
	if (!/[^/]\.md$/i.test(path)) throw new VaultError(`"${path}" is not a markdown page. Page paths must end in .md.`);
}

/** Normalizes a folder prefix for list(): "" for the root, otherwise ending in "/". */
export function normalizePrefix(input = ''): string {
	const prefix = input.trim().replace(/^\/+/, '').replace(/\/*$/, '').normalize('NFC');
	return prefix ? `${normalizePath(prefix)}/` : '';
}

/** Throws if `content` (grown by `extraChars`, for edits not yet applied) is over the page limit. */
export function checkSize(content: string, extraChars = 0): void {
	// Cheap upper bound first (a UTF-16 unit is at most 3 UTF-8 bytes), so huge results are never built.
	if (content.length + extraChars > LIMITS.pageBytes) {
		throw new VaultError(`Pages can be at most ${LIMITS.pageBytes / 1024} KB.`);
	}
	if (extraChars === 0 && new TextEncoder().encode(content).length > LIMITS.pageBytes) {
		throw new VaultError(`Pages can be at most ${LIMITS.pageBytes / 1024} KB.`);
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
