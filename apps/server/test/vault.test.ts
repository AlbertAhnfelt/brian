import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { failure } from './helpers';

const vault = (name = crypto.randomUUID()) => env.VAULT.getByName(name);

describe('Vault', () => {
	it('creates, reads and refuses to create twice', async () => {
		const v = vault();
		const page = await v.write('notes/a.md', 'hello');
		expect((await v.read('/notes/a.md')).content).toBe('hello');
		expect(page.etag).toBeTruthy();
		expect(await failure(v.write('notes/a.md', 'again'))).toMatch(/already exists/);
	});

	it('overwrites only with the current etag', async () => {
		const v = vault();
		const first = await v.write('a.md', 'one');
		const second = await v.write('a.md', 'two', first.etag);
		expect(await failure(v.write('a.md', 'lost', first.etag))).toMatch(/changed since/);
		expect((await v.read('a.md')).content).toBe('two');
		expect(second.etag).not.toBe(first.etag);
	});

	it('edits by exact replacement', async () => {
		const v = vault();
		await v.write('a.md', '- one\n- two');
		expect(await failure(v.edit('a.md', '-', '*'))).toMatch(/2 times/);
		expect(await failure(v.edit('a.md', 'three', 'x'))).toMatch(/not found/);
		await v.edit('a.md', '- two', '- 2');
		expect((await v.read('a.md')).content).toBe('- one\n- 2');
		await v.edit('a.md', '-', '*', true);
		expect((await v.read('a.md')).content).toBe('* one\n* 2');
	});

	it('treats $ in replacements literally', async () => {
		const v = vault();
		await v.write('a.md', 'price: X');
		await v.edit('a.md', 'X', "$& $1 $'");
		expect((await v.read('a.md')).content).toBe("price: $& $1 $'");
	});

	it('lists folders and files like ls', async () => {
		const v = vault();
		await v.write('top.md', '');
		await v.write('notes/a.md', '');
		await v.write('notes/deep/b.md', '');
		expect(await v.list('')).toEqual({ folders: ['notes/'], files: ['top.md'] });
		expect(await v.list('notes')).toEqual({ folders: ['notes/deep/'], files: ['notes/a.md'] });
	});

	it('does not treat LIKE wildcards in prefixes as wildcards', async () => {
		const v = vault();
		await v.write('a_b/x.md', '');
		await v.write('axb/y.md', '');
		expect((await v.list('a_b')).files).toEqual(['a_b/x.md']);
	});

	it('searches contents and paths, and keeps the index in sync', async () => {
		const v = vault();
		await v.write('dogs/brian.md', 'Brian likes martinis');
		await v.write('cats.md', 'nothing here');
		expect((await v.search('martini*')).map((h) => h.path)).toEqual(['dogs/brian.md']);
		expect((await v.search('brian')).map((h) => h.path)).toEqual(['dogs/brian.md']);
		await v.move('dogs/brian.md', 'dogs/stewie.md');
		expect((await v.search('martini*')).map((h) => h.path)).toEqual(['dogs/stewie.md']);
		await v.delete('dogs/stewie.md');
		expect(await v.search('martini*')).toEqual([]);
		expect(await v.search('"OR NEAR( -')).toEqual([]);
	});

	it('moves without overwriting', async () => {
		const v = vault();
		await v.write('a.md', 'a');
		await v.write('b.md', 'b');
		expect(await failure(v.move('a.md', 'b.md'))).toMatch(/already exists/);
		await v.move('a.md', 'c.md');
		expect(await failure(v.read('a.md'))).toMatch(/No page/);
		expect((await v.read('c.md')).content).toBe('a');
	});

	it('rejects pages over the size limit', async () => {
		expect(await failure(vault().write('big.md', 'x'.repeat(1024 * 1024 + 1)))).toMatch(/at most/);
	});

	it('exports everything and destroys everything', async () => {
		const v = vault();
		await v.write('a.md', 'a');
		await v.write('b/c.md', 'c');
		await v.delete('a.md');
		expect((await v.exportAll()).map((p) => p.path)).toEqual(['b/c.md', expect.stringMatching(/^\.trash\/.+\/a\.md$/)]);
		await v.destroy();
		expect(await v.exportAll()).toEqual([]);
		expect(await v.list('')).toEqual({ folders: [], files: [] });
	});
});

describe('Vault hardening', () => {
	it('lists folders with emoji names', async () => {
		const v = vault();
		await v.write('🐶 dogs/brian.md', '');
		expect(await v.list('🐶 dogs')).toEqual({ folders: [], files: ['🐶 dogs/brian.md'] });
	});

	it('refuses a replace_all that would blow up the page, without building it', async () => {
		const v = vault();
		await v.write('a.md', 'a'.repeat(1024 * 1024));
		expect(await failure(v.edit('a.md', 'a', 'b'.repeat(100_000), true))).toMatch(/at most/);
		expect((await v.read('a.md')).content.length).toBe(1024 * 1024);
	});

	it('refuses multi-byte edits over the limit', async () => {
		const v = vault();
		await v.write('a.md', 'x'.repeat(400_000));
		await v.edit('a.md', 'x', 'é', true);
		expect(await failure(v.edit('a.md', 'é', '日本', true))).toMatch(/at most/);
	});

	it.each(['..\\..\\evil.md', 'C:/Windows/evil.md', 'a\u2215..\u2215b.md', 'invoice\u202Etxt.md', 'zero\u200Bwidth.md'])(
		'rejects unsafe path %j',
		async (path) => expect(await failure(vault().write(path, 'x'))).toMatch(/cannot contain/)
	);

	it('includes the trash in exports and purges it after 30 days', async () => {
		const v = vault();
		await v.write('old.md', 'old');
		await v.delete('old.md');
		expect((await v.exportAll()).map((p) => p.path)).toEqual([expect.stringMatching(/^\.trash\/.+\/old\.md$/)]);

		await runInDurableObject(v, (_, state) => {
			state.storage.sql.exec(`UPDATE trash SET deleted_at = deleted_at - 31 * 24 * 60 * 60 * 1000`);
		});
		await v.write('new.md', 'new');
		await v.delete('new.md');
		expect((await v.exportAll()).map((p) => p.path)).toEqual([expect.stringMatching(/\/new\.md$/)]);
	});

	it.each(['notes/a.txt', 'image.png', 'notes/.md', 'md', 'a.md.txt'])('refuses to create non-markdown page %j', async (path) => {
		expect(await failure(vault().write(path, 'x'))).toMatch(/must end in \.md/);
	});

	it('accepts .md in any case, and refuses to move a page to a non-markdown path', async () => {
		const v = vault();
		await v.write('Upper.MD', 'x');
		expect(await failure(v.move('Upper.MD', 'upper.txt'))).toMatch(/must end in \.md/);
		await v.move('Upper.MD', 'lower.md');
		expect((await v.read('lower.md')).content).toBe('x');
	});

	it('still reads, edits and deletes older non-markdown pages', async () => {
		const v = vault();
		await runInDurableObject(v, (_, state) => {
			state.storage.sql.exec(`INSERT INTO pages (path, content, etag, updated_at) VALUES ('old.txt', 'hi', 'e1', 0)`);
		});
		await v.write('old.txt', 'hello', 'e1');
		await v.edit('old.txt', 'hello', 'hey');
		expect((await v.read('old.txt')).content).toBe('hey');
		await v.delete('old.txt');
	});

	it('refuses new pages past the page limit, but still allows overwrites', async () => {
		const v = vault();
		const first = await v.write('a.md', 'one');
		await runInDurableObject(v, (_, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
				 INSERT INTO pages (path, content, etag, updated_at) SELECT 'p' || i || '.md', '', 'e', 0 FROM n`
			);
		});
		expect(await failure(v.write('b.md', 'two'))).toMatch(/full \(10,000 pages\)/);
		await v.write('a.md', 'changed', first.etag);
		await v.move('a.md', 'c.md');
		await v.delete('c.md');
		await v.write('b.md', 'two');
	});
});
