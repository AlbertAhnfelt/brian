import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applySplices, setText, splices, TEXT } from '../src/text';

const apply = (from: string, to: string) => {
	let text = from;
	for (const { index, remove, insert } of splices(from, to)) text = text.slice(0, index) + insert + text.slice(index + remove);
	return text;
};

/** A small random generator, seeded so failures can be replayed. */
function random(seed: number) {
	return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const ALPHABET = ['a', 'b', ' ', '\n', 'é', '😀', '🎉', '日'];

function mutate(text: string, rand: () => number): string {
	const chars = Array.from(text);
	for (let n = Math.floor(rand() * 4) + 1; n > 0; n--) {
		const at = Math.floor(rand() * (chars.length + 1));
		if (rand() < 0.5 && chars.length) chars.splice(at, Math.ceil(rand() * 3));
		else chars.splice(at, 0, ...Array.from({ length: Math.ceil(rand() * 3) }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]));
	}
	return chars.join('');
}

describe('splices', () => {
	it('turns one text into another', () => {
		expect(splices('same', 'same')).toEqual([]);
		expect(splices('hello world', 'hello there world')).toEqual([{ index: 6, remove: 0, insert: 'there ' }]);
		expect(apply('one two three', 'one 2 three!')).toBe('one 2 three!');
	});

	it('never splits an emoji, so Yjs never stores half of one', () => {
		const list = splices('a😀b', 'a😁b');
		expect(list).toEqual([{ index: 1, remove: 2, insert: '😁' }]);
		for (const { insert } of list) expect(insert).toBe(insert.toWellFormed());
	});

	it('is exact and well-formed on random edits', () => {
		const rand = random(7);
		for (let i = 0; i < 500; i++) {
			const from = mutate('the quick 😀 brown fox', rand);
			const to = mutate(from, rand);
			expect(apply(from, to)).toBe(to);
			const doc = new Y.Doc();
			const text = doc.getText(TEXT);
			text.insert(0, from);
			doc.transact(() => applySplices(text, splices(from, to)));
			// Through an encoded update, as it would travel between devices.
			const copy = new Y.Doc();
			Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
			expect(copy.getText(TEXT).toString()).toBe(to);
		}
	});
});

describe('two devices editing the same page', () => {
	it('end up with the same text, keeping both edits, whatever order they sync in', () => {
		const rand = random(42);
		for (let i = 0; i < 300; i++) {
			const base = new Y.Doc();
			setText(base.getText(TEXT), mutate('shared start text 😀\nsecond line', rand));
			const devices = [new Y.Doc(), new Y.Doc()];
			for (const d of devices) Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
			// Both edit offline, each turning its file into new text.
			const updates = devices.map((d) => {
				const before = Y.encodeStateVector(d);
				d.transact(() => setText(d.getText(TEXT), mutate(d.getText(TEXT).toString(), rand)));
				return Y.encodeStateAsUpdate(d, before);
			});
			Y.applyUpdate(devices[0], updates[1]);
			Y.applyUpdate(devices[1], updates[0]);
			expect(devices[0].getText(TEXT).toString()).toBe(devices[1].getText(TEXT).toString());
		}
	});

	it('keeps edits to different lines intact', () => {
		const base = new Y.Doc();
		base.getText(TEXT).insert(0, 'line one\nline two\n');
		const [a, b] = [new Y.Doc(), new Y.Doc()];
		for (const d of [a, b]) Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
		a.transact(() => setText(a.getText(TEXT), 'line ONE\nline two\n'));
		b.transact(() => setText(b.getText(TEXT), 'line one\nline two, edited\n'));
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		expect(a.getText(TEXT).toString()).toBe('line ONE\nline two, edited\n');
	});
});
