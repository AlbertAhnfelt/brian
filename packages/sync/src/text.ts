import DiffMatchPatch from 'diff-match-patch';
import * as Y from 'yjs';

/** The name of the Y.Text that holds a page's markdown inside its Y.Doc. */
export const TEXT = 'content';

/** Replace `remove` characters at `index` with `insert` (UTF-16 offsets, like JavaScript strings). */
export interface Splice {
	index: number;
	remove: number;
	insert: string;
}

const dmp = new DiffMatchPatch();
// A huge rewrite gets a coarser diff after half a second rather than a slow exact one.
dmp.Diff_Timeout = 0.5;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The splices that turn `from` into `to`, applied in order. Kept small, because a CRDT merges
 * concurrent edits best when each one touches as little text as possible. Never splits a
 * surrogate pair (an emoji, say): Yjs would encode half a pair as U+FFFD.
 */
export function splices(from: string, to: string): Splice[] {
	if (from === to) return [];
	const diffs = dmp.diff_main(from, to);
	dmp.diff_cleanupSemanticLossless(diffs); // shifts edges to word boundaries without growing edits

	// Regions of `from` to replace: [start, end) → insert.
	const regions: { start: number; end: number; insert: string }[] = [];
	let at = 0;
	for (const [op, text] of diffs) {
		if (op === DiffMatchPatch.DIFF_EQUAL) {
			at += text.length;
			continue;
		}
		const last = regions.at(-1);
		const region = last && last.end === at ? last : { start: at, end: at, insert: '' };
		if (region !== last) regions.push(region);
		if (op === DiffMatchPatch.DIFF_DELETE) {
			region.end += text.length;
			at += text.length;
		} else {
			region.insert += text;
		}
	}

	// Widen any region whose edge falls inside a surrogate pair, then merge regions that touch.
	const splitsPair = (offset: number) => isHigh(from.charCodeAt(offset - 1)) && isLow(from.charCodeAt(offset));
	const merged: typeof regions = [];
	for (const region of regions) {
		if (splitsPair(region.start)) {
			region.start -= 1;
			region.insert = from[region.start] + region.insert;
		}
		if (splitsPair(region.end)) {
			region.insert += from[region.end];
			region.end += 1;
		}
		const last = merged.at(-1);
		if (last && last.end >= region.start) {
			last.insert += from.slice(last.end, region.start) + region.insert;
			last.end = Math.max(last.end, region.end);
		} else {
			merged.push(region);
		}
	}

	let shift = 0;
	return merged.map(({ start, end, insert }) => {
		const splice = { index: start + shift, remove: end - start, insert };
		shift += insert.length - (end - start);
		return splice;
	});
}

/** Applies splices to a Y.Text. Call inside `doc.transact` so they become one update. */
export function applySplices(text: Y.Text, list: Splice[]): void {
	for (const { index, remove, insert } of list) {
		if (remove) text.delete(index, remove);
		if (insert) text.insert(index, insert);
	}
}

/** Makes the Y.Text read `value`, with the smallest edit. Call inside `doc.transact`. */
export function setText(text: Y.Text, value: string): void {
	applySplices(text, splices(text.toString(), value));
}
