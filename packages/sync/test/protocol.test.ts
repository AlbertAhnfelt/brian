import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, MAX_FRAME_BYTES } from '../src/protocol';

describe('frames', () => {
	it('carry a header and raw payloads', () => {
		const frame = encodeFrame({ t: 'push', ref: 3, id: 'p_x' }, [new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([9])]);
		const { header, payloads } = decodeFrame(frame);
		expect(header).toMatchObject({ t: 'push', ref: 3, id: 'p_x', sizes: [2, 0, 1] });
		expect(payloads.map((p) => [...p])).toEqual([[1, 2], [], [9]]);
		expect(decodeFrame(frame.buffer as ArrayBuffer).payloads).toHaveLength(3);
	});

	it('refuse anything malformed', () => {
		const good = encodeFrame({ t: 'x' }, [new Uint8Array([1])]);
		const bad = [
			new Uint8Array([0, 0]),
			new Uint8Array([0, 0, 1, 0, 123]),
			encodeFrame({ t: 'x' }).slice(0, -1),
			new Uint8Array([...good, 7]),
			good.slice(0, -1),
			Uint8Array.from([0, 0, 0, 2, ...new TextEncoder().encode('[]')]),
			Uint8Array.from([0, 0, 0, 14, ...new TextEncoder().encode('{"sizes":[-1]}')]),
			new Uint8Array(MAX_FRAME_BYTES + 1)
		];
		for (const frame of bad) expect(() => decodeFrame(frame)).toThrow();
	});
});
