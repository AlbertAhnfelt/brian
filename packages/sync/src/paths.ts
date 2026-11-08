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
