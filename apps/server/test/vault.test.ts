import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { failure } from './helpers';

const vault = (name = crypto.randomUUID()) => env.VAULT.getByName(name);
const human = { user: 'u_1', source: 'Obsidian' };
const agent = { user: 'u_1', source: 'Claude' };

/** Turns `v` into a vault of the first schema (pages keyed by path, no Yjs) holding `pages`, then upgrades it. */
async function legacy(v: ReturnType<typeof vault>, pages: [string, string][], trash: [string, string][] = []) {
	await runInDurableObject(v, (instance, state) => {
		const sql = state.storage.sql;
		for (const table of ['pages', 'ystate', 'deleted', 'history', 'trash', 'pages_fts', 'meta']) sql.exec(`DROP TABLE IF EXISTS ${table}`);
		sql.exec(`
			CREATE TABLE pages (path TEXT PRIMARY KEY, content TEXT NOT NULL, etag TEXT NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE deleted (path TEXT PRIMARY KEY, seq INTEGER NOT NULL, deleted_at INTEGER NOT NULL);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
			CREATE TABLE trash (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL, deleted_at INTEGER NOT NULL);
			CREATE VIRTUAL TABLE pages_fts USING fts5(path, content, tokenize = 'porter unicode61');
		`);
		sql.exec(`INSERT INTO meta (key, value) VALUES ('seq', ?)`, pages.length);
		for (const [path, content] of pages) sql.exec(`INSERT INTO pages (path, content, etag, updated_at) VALUES (?, ?, 'e', 0)`, path, content);
		for (const [path, content] of trash) sql.exec(`INSERT INTO trash (path, content, deleted_at) VALUES (?, ?, ?)`, path, content, Date.now());
		(instance as unknown as { migrate(): void }).migrate();
	});
}

/** The text of a page's stored Yjs document, which must always equal its markdown. */
async function yText(v: ReturnType<typeof vault>, id: string): Promise<string> {
	return runInDurableObject(v, (_, state) => {
		const parts = state.storage.sql
			.exec<{ data: ArrayBuffer }>(`SELECT data FROM ystate WHERE page_id = ? ORDER BY part`, id)
			.toArray()
			.map((r) => new Uint8Array(r.data));
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Uint8Array.from(parts.flatMap((p) => [...p])));
		return doc.getText('content').toString();
	});
}

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
		expect(await failure(vault().write(path, 'x'))).toMatch(/must end in \.md|starts with a dot/);
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
		await legacy(v, [['old.txt', 'hi']]);
		await v.write('old.txt', 'hello', (await v.read('old.txt')).etag);
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
				 INSERT INTO pages (id, path, fold, content, etag, updated_at, seq) SELECT 'x' || i, 'p' || i || '.md', 'p' || i || '.md', '', 'e', 0, 0 FROM n`
			);
		});
		expect(await failure(v.write('b.md', 'two'))).toMatch(/full \(10,000 pages\)/);
		await v.write('a.md', 'changed', first.etag);
		await v.move('a.md', 'c.md');
		await v.delete('c.md');
		await v.write('b.md', 'two');
	});
});

describe('change feed', () => {
	it('numbers every write and delete, oldest first', async () => {
		const v = vault();
		const a = await v.write('a.md', 'one');
		await v.write('b.md', 'two');
		await v.edit('a.md', 'one', 'uno');
		await v.move('b.md', 'c.md');
		await v.delete('a.md');
		const { changes, cursor, more } = await v.changes(0);
		// A move is a change to the same page (same id), not a delete plus a create.
		expect(changes.map((c) => [c.path, c.deleted])).toEqual([
			['c.md', false],
			['a.md', true]
		]);
		expect(changes.map((c) => c.seq)).toEqual([4, 5]);
		expect(changes[1].id).toBe(a.id);
		expect(cursor).toBe(5);
		expect(more).toBe(false);
	});

	it('continues from a cursor, a page at a time', async () => {
		const v = vault();
		for (const name of ['a', 'b', 'c']) await v.write(`${name}.md`, name);
		const first = await v.changes(0, 2);
		expect(first.changes.map((c) => c.path)).toEqual(['a.md', 'b.md']);
		expect(first.more).toBe(true);
		const rest = await v.changes(first.cursor, 2);
		expect(rest.changes.map((c) => c.path)).toEqual(['c.md']);
		expect(rest.more).toBe(false);
		expect((await v.changes(rest.cursor)).changes).toEqual([]);
	});

	it('treats a page written again at a deleted path as a new page', async () => {
		const v = vault();
		const old = await v.write('a.md', 'one');
		await v.delete('a.md');
		const again = await v.write('a.md', 'again');
		expect(again.id).not.toBe(old.id);
		expect((await v.changes(0)).changes).toMatchObject([
			{ id: old.id, path: 'a.md', deleted: true, seq: 2 },
			{ id: again.id, path: 'a.md', deleted: false, seq: 3 }
		]);
	});

	it('scores search hits so results from several brians can be merged', async () => {
		const v = vault();
		await v.write('apples.md', 'apples apples apples');
		await v.write('other.md', 'one apples mention among many other words here');
		const hits = await v.search('apples');
		expect(hits.map((h) => h.path)).toEqual(['apples.md', 'other.md']);
		expect(hits[0].score).toBeLessThan(hits[1].score);
	});
});

describe('case-insensitive paths', () => {
	it('finds a page in any casing and refuses a case-only duplicate', async () => {
		const v = vault();
		await v.write('Notes/Plan.md', 'hello');
		expect((await v.read('notes/plan.md')).path).toBe('Notes/Plan.md');
		expect(await failure(v.write('notes/PLAN.md', 'other'))).toMatch(/"Notes\/Plan.md" already exists/);
		const { etag } = await v.read('NOTES/plan.md');
		expect((await v.write('notes/plan.md', 'updated', etag)).path).toBe('Notes/Plan.md');
	});

	it('puts new pages into the folder casing that exists', async () => {
		const v = vault();
		await v.write('Notes/Deep/a.md', 'a');
		expect((await v.write('notes/deep/b.md', 'b')).path).toBe('Notes/Deep/b.md');
		expect((await v.write('NOTES/other/c.md', 'c')).path).toBe('Notes/other/c.md');
		expect(await v.list('notes')).toEqual({ folders: ['Notes/Deep/', 'Notes/other/'], files: [] });
	});

	it('renames by case, but not onto another page', async () => {
		const v = vault();
		await v.write('a.md', 'a');
		await v.write('b.md', 'b');
		expect((await v.move('a.md', 'A.md')).path).toBe('A.md');
		expect(await failure(v.move('A.md', 'B.md'))).toMatch(/"b.md" already exists/);
	});

	it('stores LF line endings, and edits match across them', async () => {
		const v = vault();
		await v.write('a.md', 'one\r\ntwo\r\n');
		expect((await v.read('a.md')).content).toBe('one\ntwo\n');
		await v.edit('a.md', 'one\r\ntwo', 'uno\r\ndos');
		expect((await v.read('a.md')).content).toBe('uno\ndos\n');
	});

});

describe('upgrading a vault of the first schema', () => {
	it('gives every page an id and a Yjs document, repairs paths, and loses nothing', async () => {
		const v = vault();
		await legacy(
			v,
			[
				['keep.md', 'keep'],
				['Notes/a.md', 'a'],
				['notes/b.md', 'b'],
				['Keep.md', 'second keep'],
				['a:b.md', 'colon'],
				['a-b.md', 'dash'],
				['crlf.md', 'x\r\ny']
			],
			[['gone.md', 'bye']]
		);
		const all = Object.fromEntries((await v.exportAll()).filter((p) => !p.path.startsWith('.trash/')).map((p) => [p.path, p.content]));
		expect(all).toEqual({
			'keep.md': 'keep',
			'Notes/a.md': 'a',
			'Notes/b.md': 'b',
			'Keep 2.md': 'second keep',
			'a-b 2.md': 'colon',
			'a-b.md': 'dash',
			'crlf.md': 'x\ny'
		});
		expect((await v.exportAll()).filter((p) => p.path.startsWith('.trash/')).map((p) => p.content)).toEqual(['bye']);
		const { changes } = await v.changes(0);
		expect(changes).toHaveLength(7);
		expect(changes.every((c) => !c.deleted && c.id.startsWith('p_'))).toBe(true);
		const page = await v.edit('a-b 2.md', 'colon', 'semicolon');
		expect(await yText(v, page.id)).toBe('semicolon');
		expect(await failure(v.write('KEEP.md', 'x'))).toMatch(/already exists/);
	});
});

describe('Yjs documents', () => {
	it('always read the same as the markdown, emoji and all', async () => {
		const v = vault();
		const page = await v.write('a.md', 'hi 😀 there');
		await v.edit('a.md', '😀', '😁');
		await v.write('a.md', 'hello 😁 there, 🎉', (await v.read('a.md')).etag);
		await v.edit('a.md', 'there', 'world', true);
		expect((await v.read('a.md')).content).toBe('hello 😁 world, 🎉');
		expect(await yText(v, page.id)).toBe('hello 😁 world, 🎉');
	});

	it('store pages near the size limit in several parts', async () => {
		const v = vault();
		const page = await v.write('big.md', `START${'ab'.repeat(500_000)}`);
		await v.edit('big.md', 'START', 'X');
		const text = (await v.read('big.md')).content;
		expect(text.startsWith('Xab')).toBe(true);
		expect(await yText(v, page.id)).toBe(text);
		const parts = await runInDurableObject(v, (_, s) => s.storage.sql.exec(`SELECT COUNT(*) AS n FROM ystate WHERE page_id = ?`, page.id).one().n);
		expect(parts).toBeGreaterThan(1);
	});

	it("keep a trashed page's document until the trash is emptied", async () => {
		const v = vault();
		const page = await v.write('a.md', 'x');
		await v.delete('a.md');
		const count = () => runInDurableObject(v, (_, s) => s.storage.sql.exec(`SELECT COUNT(*) AS n FROM ystate WHERE page_id = ?`, page.id).one().n);
		expect(await count()).toBe(1);
		await runInDurableObject(v, (_, s) => s.storage.sql.exec(`UPDATE trash SET deleted_at = 0`));
		await v.write('b.md', 'y');
		await v.delete('b.md');
		expect(await count()).toBe(0);
	});
});

describe('page history', () => {
	it('records who did what, keeping the id through renames', async () => {
		const v = vault();
		const page = await v.write('a.md', 'one', undefined, human);
		await v.edit('a.md', 'one', 'two', false, agent);
		const moved = await v.move('a.md', 'b.md', human);
		expect(moved.id).toBe(page.id);
		expect((await v.history('b.md')).map((h) => [h.action, h.path, h.fromPath, h.source])).toEqual([
			['move', 'b.md', 'a.md', 'Obsidian'],
			['edit', 'a.md', null, 'Claude'],
			['create', 'a.md', null, 'Obsidian']
		]);
	});

	it('folds a run of edits by one author into one entry', async () => {
		const v = vault();
		await v.write('a.md', '1', undefined, human);
		for (const n of ['2', '3', '4']) await v.write('a.md', n, (await v.read('a.md')).etag, human);
		await v.edit('a.md', '4', '5', false, agent);
		await v.edit('a.md', '5', '6', false, human);
		expect((await v.history('a.md')).map((h) => `${h.action}:${h.source}`)).toEqual(['edit:Obsidian', 'edit:Claude', 'edit:Obsidian', 'create:Obsidian']);
	});
});

describe('folder moves', () => {
	it('moves everything in a folder as one change, keeping ids', async () => {
		const v = vault();
		const a = await v.write('old/a.md', 'a');
		await v.write('old/deep/b.md', 'b');
		await v.write('other.md', 'o');
		expect((await v.moveFolder('old', 'new/place')).sort()).toEqual(['new/place/a.md', 'new/place/deep/b.md']);
		expect((await v.read('new/place/a.md')).id).toBe(a.id);
		expect(await v.list('')).toEqual({ folders: ['new/'], files: ['other.md'] });
	});

	it('changes the case of a folder', async () => {
		const v = vault();
		await v.write('notes/a.md', 'a');
		expect(await v.moveFolder('notes/', 'Notes/')).toEqual(['Notes/a.md']);
	});

	it('joins the casing of a folder that exists, and refuses clashes and moves into itself', async () => {
		const v = vault();
		await v.write('src/a.md', 'a');
		await v.write('src/b.md', 'b');
		await v.write('Dest/b.md', 'existing');
		expect(await failure(v.moveFolder('src', 'dest'))).toMatch(/"Dest\/b.md" already exists/);
		expect(await failure(v.moveFolder('src', 'src/inner'))).toMatch(/into itself/);
		expect(await failure(v.moveFolder('nothing', 'x'))).toMatch(/No folder/);
		await v.delete('Dest/b.md');
		await v.write('Dest/c.md', 'c');
		expect((await v.moveFolder('src', 'dest')).sort()).toEqual(['Dest/a.md', 'Dest/b.md']);
	});
});
