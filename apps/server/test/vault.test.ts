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
		expect((await v.exportAll()).map((p) => p.path)).toEqual(['b/c.md']);
		await v.destroy();
		expect(await v.exportAll()).toEqual([]);
		expect(await v.list('')).toEqual({ folders: [], files: [] });
	});
});
