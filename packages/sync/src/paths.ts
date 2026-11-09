/**
 * The case-insensitive form of a path. Macs, Windows and phones treat "Note.md" and "note.md" as
 * one file, so a brian never holds two pages that differ only in case.
 */
export function foldPath(path: string): string {
	return path.normalize('NFC').toLowerCase().normalize('NFC');
}

/** "notes/idea.md" with n = 2 → "notes/idea 2.md", the name given to the second of two pages. */
export function numbered(path: string, n: number): string {
	const slash = path.lastIndexOf('/') + 1;
	const name = path.slice(slash);
	const dot = name.lastIndexOf('.');
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	return `${path.slice(0, slash)}${stem} ${n}${ext}`;
}

/** Page text with LF line endings only, as Obsidian writes it. */
export function normalizeText(text: string): string {
	return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** "\" and ":" are separators on Windows; the rest Windows can't store; then look-alikes and invisibles. */
export const FORBIDDEN = /[\\:*?"<>|]|\p{Cf}|[∕⁄／]/u;
/** Windows device names, with or without an extension ("con.md"). */
export const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Why Brian can't store a page at `path` (already NFC), or null if it can. Every page must be a
 * file Obsidian can create on any device, Windows included. Length is checked by the server.
 */
export function pathProblem(path: string): string | null {
	if (!path || path.endsWith('/')) return `"${path}" is not a page path.`;
	const segments = path.split('/');
	if (segments.some((s) => s === '' || s === '.' || s === '..')) return `"${path}" has an empty, "." or ".." segment.`;
	if (/[\u0000-\u001f\u007f]/.test(path)) return 'Paths cannot contain control characters.';
	if (FORBIDDEN.test(path)) return 'Paths cannot contain \\ : * ? " < > |, slash look-alikes or invisible formatting characters.';
	for (const segment of segments) {
		if (segment.startsWith('.')) return `"${segment}" starts with a dot: Obsidian hides such files and folders.`;
		if (/[ .]$/.test(segment)) return `"${segment}" ends with a space or a dot, which Windows can't store.`;
		if (RESERVED.test(segment)) return `"${segment}" is a reserved name on Windows.`;
	}
	return null;
}

/**
 * The closest path Brian can store: forbidden characters become "-", leading dots and trailing
 * spaces or dots go, Windows device names get a "-". Null if nothing usable is left.
 */
export function repairPath(path: string): string | null {
	const repaired = path
		.normalize('NFC')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(new RegExp(FORBIDDEN.source, 'gu'), '-')
		.split('/')
		.map((s) => s.trim().replace(/^\.+/, '').replace(/[ .]+$/, ''))
		.map((s) => (RESERVED.test(s) ? `${s}-` : s))
		.filter((s) => s && s !== '..')
		.join('/');
	return pathProblem(repaired) === null ? repaired : null;
}
