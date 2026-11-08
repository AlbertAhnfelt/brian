import { safeNext } from '@brian/shared';
import { describe, expect, it } from 'vitest';
import { foldPath, ftsQuery, normalizePath, normalizePrefix, normalizeText, numbered, repairPath } from '../src/vault/paths';

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

describe('path rules every device can store', () => {
	it.each(['a*b.md', 'a?.md', 'say "hi".md', 'a<b>.md', 'a|b.md', 'a:b.md', '.hidden/x.md', 'notes/.x.md', 'trailing /x.md', 'dot./x.md', 'x.md.', 'con.md', 'Notes/LPT1/x.md', 'a​b.md'])(
		'rejects %j',
		(path) => expect(() => normalizePath(path)).toThrow()
	);

	it('accepts what Obsidian accepts', () => {
		for (const path of ['möten/2026 #1 [draft].md', 'a^b.md', 'console.md', 'Ångström.md']) expect(normalizePath(path)).toBe(path);
	});

	it('stores "å" one way, however it was typed', () => {
		expect(normalizePath('å.md')).toBe('å.md');
	});

	it('folds case, numbers clashes, and converts line endings', () => {
		expect(foldPath('Möten/Plan.MD')).toBe('möten/plan.md');
		expect(numbered('notes/idea.md', 2)).toBe('notes/idea 2.md');
		expect(numbered('README', 3)).toBe('README 3');
		expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
	});

	it('repairs old paths into valid ones', () => {
		expect(repairPath('a:b/c*d.md')).toBe('a-b/c-d.md');
		expect(repairPath('.hidden/con/x.md')).toBe('hidden/con-/x.md');
		expect(repairPath('ok/fine.md')).toBe('ok/fine.md');
		expect(repairPath('...')).toBe('untitled.md');
	});
});
