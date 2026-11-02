import { safeNext } from '@brian/shared';
import { describe, expect, it } from 'vitest';
import { ftsQuery, normalizePath, normalizePrefix } from '../src/vault/paths';

describe('normalizePath', () => {
	it('strips leading slashes and keeps folders', () => {
		expect(normalizePath('/notes/today.md')).toBe('notes/today.md');
	});

	it.each(['', '/', 'notes/', 'a//b.md', 'a/./b.md', '../secret.md', 'a/../b.md', 'a\u0000b.md'])(
		'rejects %j',
		(path) => expect(() => normalizePath(path)).toThrow()
	);

	it('rejects very long paths', () => {
		expect(() => normalizePath('a'.repeat(513))).toThrow();
	});
});

describe('normalizePrefix', () => {
	it('treats empty as the root and adds a trailing slash otherwise', () => {
		expect(normalizePrefix('')).toBe('');
		expect(normalizePrefix('notes')).toBe('notes/');
		expect(normalizePrefix('/notes/')).toBe('notes/');
	});
});

describe('ftsQuery', () => {
	it('quotes every word so FTS5 syntax is inert', () => {
		expect(ftsQuery('dog OR NEAR(cat')).toBe('"dog" "OR" "NEAR(cat"');
		expect(ftsQuery('say "hi"')).toBe('"say" """hi"""');
	});

	it('keeps prefix matching with a trailing *', () => {
		expect(ftsQuery('proj*')).toBe('"proj"*');
	});
});

describe('safeNext', () => {
	it('allows same-site paths', () => {
		expect(safeNext('/authorize?client_id=x')).toBe('/authorize?client_id=x');
	});

	it('keeps query and hash, normalizing like a browser', () => {
		expect(safeNext('/a/../account?x=1#top')).toBe('/account?x=1#top');
	});

	it.each([null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/\t/evil.com', '/\n/evil.com', '/\\evil.com', '/%2F/evil.com'.replace('%2F', '/')])(
		'falls back for %j',
		(next) => expect(safeNext(next)).toBe('/connect')
	);
});
