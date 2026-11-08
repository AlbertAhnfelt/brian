import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '@brian/shared';
import { applySplices, splices, TEXT, type Splice } from '@brian/sync';
import * as Y from 'yjs';
import {
	checkMarkdown,
	checkSize,
	foldPath,
	ftsQuery,
	normalizePath,
	normalizePrefix,
	normalizeText,
	numbered,
	repairPath,
	VaultError
} from './paths';

export interface Page {
	/** Stable across renames. */
	id: string;
	path: string;
	content: string;
	etag: string;
	updatedAt: number;
}

/** A page in an export: no id, and trashed pages have no etag. */
export type ExportedPage = Omit<Page, 'id'>;

export interface Listing {
	folders: string[];
	files: string[];
}

export type SearchHit = {
	path: string;
	snippet: string;
	/** BM25 rank: lower is better. Comparable enough across vaults to merge results. */
	score: number;
};

/** Who made a change: the user, and what they used ("Obsidian", "Claude", "brian" for Brian itself). */
export interface Author {
	user: string;
	source: string;
}

/** One entry in the change feed: a page as it is now, or a page that was deleted. */
export type Change = { seq: number; id: string; path: string } & ({ deleted: false; etag: string } | { deleted: true });

export interface Changes {
	changes: Change[];
	/** Pass back as `since` to continue. */
	cursor: number;
	/** True if there may be more changes after `cursor`. */
	more: boolean;
}

/** One line of a page's history. Consecutive edits by the same author are merged into one. */
export interface HistoryEntry {
	action: 'create' | 'edit' | 'move' | 'delete';
	path: string;
	fromPath: string | null;
	user: string;
	source: string;
	at: number;
}

/** Writes Brian makes itself (templates, migrations). */
const BRIAN: Author = { user: '', source: 'brian' };
/** Edits by the same author to the same page within this window count as one in the history. */
const HISTORY_MERGE_MS = 5 * 60 * 1000;
/** Durable Object SQLite rows are capped at 2 MB, so Yjs state is stored in parts. */
const PART_BYTES = 512 * 1024;
const SCHEMA = 2;
/** A replace_all with more matches than this is applied as one diff instead of one splice each. */
const MAX_EXACT_SPLICES = 200;

type PageRow = { id: string; path: string; content: string; etag: string; updated_at: number };

/**
 * One brian's pages. A user's personal brian is the Durable Object named by their user ID; a
 * shared brian is the one named by its brian ID ("b_…"). Each has its own SQLite database, so a
 * request routed to one brian can never reach another's pages. Shared brians store paths
 * relative to their own folder, so each member can mount them under any name.
 *
 * Every page has a stable id, its markdown, and its Yjs document (a CRDT, the form in which
 * edits from several devices merge). The two always agree: every write goes through the Yjs
 * document, and the markdown is what it reads. Search, MCP and export use the markdown.
 *
 * Every write takes the next number from a per-vault counter (`seq`), and deletes leave a
 * record, so a sync client can ask for everything that changed since the last number it saw.
 * Every write is also recorded, with its author, in the page's history.
 *
 * Paths are case-insensitive, like files on a Mac, Windows or a phone: a page keeps the casing it
 * was created with, any casing finds it, and a new page joins its folder's existing casing.
 *
 * Every method runs synchronous SQL with no awaits in between, so each call is atomic.
 */
export class Vault extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.migrate();
	}

	private migrate(): void {
		const tables = new Set(this.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((r) => r.name));
		const version = tables.has('meta')
			? (this.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'schema'`).toArray()[0]?.value ?? 1)
			: 0;
		if (version === SCHEMA) return;
		this.ctx.storage.transactionSync(() => {
			if (version === 0 || !tables.has('pages')) this.createSchema();
			else this.upgradeFromV1();
		});
	}

	private createSchema(): void {
		this.sql.exec(`
			CREATE TABLE pages (
				id TEXT PRIMARY KEY,
				path TEXT NOT NULL UNIQUE,
				fold TEXT NOT NULL UNIQUE,
				content TEXT NOT NULL,
				etag TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				seq INTEGER NOT NULL
			);
			CREATE INDEX pages_seq ON pages (seq);
			CREATE TABLE ystate (
				page_id TEXT NOT NULL,
				part INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY (page_id, part)
			);
			CREATE TABLE deleted (
				id TEXT PRIMARY KEY,
				path TEXT NOT NULL,
				seq INTEGER NOT NULL,
				deleted_at INTEGER NOT NULL
			);
			CREATE INDEX deleted_seq ON deleted (seq);
			CREATE TABLE history (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				page_id TEXT NOT NULL,
				action TEXT NOT NULL,
				path TEXT NOT NULL,
				from_path TEXT,
				user_id TEXT NOT NULL,
				source TEXT NOT NULL,
				at INTEGER NOT NULL
			);
			CREATE INDEX history_page ON history (page_id, seq);
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
			CREATE TABLE trash (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				page_id TEXT,
				path TEXT NOT NULL,
				content TEXT NOT NULL,
				deleted_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE pages_fts USING fts5(path, content, tokenize = 'porter unicode61');
		`);
		this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`, SCHEMA);
		// This vault's Yjs client id. Writes run one at a time, after loading the latest state,
		// so one id serves every server-side edit and keeps the documents' version vectors small.
		this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('client', ?)`, crypto.getRandomValues(new Uint32Array(1))[0] || 1);
	}

	/**
	 * From the first schema (pages keyed by path, no Yjs): rebuild every page with an id and a
	 * Yjs document, under the path rules every device can store (see `normalizePath`). Paths are
	 * repaired, each folder gets one casing, pages that now clash become "name 2.md", and line
	 * endings become LF. The change feed starts over: no sync client existed before this.
	 * Never deletes a page: when unsure, keep.
	 */
	private upgradeFromV1(): void {
		const rows = this.sql.exec<{ path: string; content: string }>(`SELECT path, content FROM pages ORDER BY rowid`).toArray();
		const trash = this.sql
			.exec<{ path: string; content: string; deleted_at: number }>(`SELECT path, content, deleted_at FROM trash ORDER BY id`)
			.toArray();
		this.sql.exec(`DROP TABLE pages; DROP TABLE IF EXISTS deleted; DROP TABLE trash; DROP TABLE pages_fts; DELETE FROM meta;`);
		this.createSchema();

		// Valid paths claim their names first, so repairing a broken path never moves a good page.
		const valid = (path: string) => repairPath(path) === path;
		rows.sort((a, b) => Number(valid(b.path)) - Number(valid(a.path)));
		const folders = new Map<string, string>(); // folded folder prefix → the casing it keeps
		const taken = new Set<string>();
		for (const row of rows) {
			const segments = repairPath(row.path).split('/');
			for (let i = 1; i < segments.length; i++) {
				const folded = foldPath(segments.slice(0, i).join('/'));
				const kept = folders.get(folded);
				if (kept) segments.splice(0, i, ...kept.split('/'));
				else folders.set(folded, segments.slice(0, i).join('/'));
			}
			let target = segments.join('/');
			for (let n = 2; taken.has(foldPath(target)); n++) target = numbered(segments.join('/'), n);
			taken.add(foldPath(target));
			this.create(target, normalizeText(row.content), BRIAN);
		}
		for (const t of trash) {
			this.sql.exec(`INSERT INTO trash (path, content, deleted_at) VALUES (?, ?, ?)`, t.path, t.content, t.deleted_at);
		}
	}

	/** Folders and files directly under a prefix, like `ls`. */
	list(prefix = ''): Listing {
		const base = normalizePrefix(prefix);
		const depth = base.split('/').length - 1;
		const folders = new Set<string>();
		const files: string[] = [];
		const rows = this.sql.exec<{ path: string }>(
			`SELECT path FROM pages WHERE substr(fold, 1, length(?1)) = ?1 ORDER BY path`,
			foldPath(base)
		);
		for (const { path } of rows) {
			// By segments, not characters: lowercasing can change a string's length.
			const segments = path.split('/');
			if (segments.length === depth + 1) files.push(path);
			else folders.add(`${segments.slice(0, depth + 1).join('/')}/`);
		}
		return { folders: [...folders], files };
	}

	/** Full-text search over paths and contents, best matches first. */
	search(query: string, limit = 20): SearchHit[] {
		const match = ftsQuery(query);
		if (!match) return [];
		return this.sql
			.exec<SearchHit>(
				`SELECT path, snippet(pages_fts, 1, '**', '**', '…', 16) AS snippet, bm25(pages_fts, 5.0, 1.0) AS score
				 FROM pages_fts WHERE pages_fts MATCH ? ORDER BY score LIMIT ?`,
				match,
				Math.min(Math.max(limit, 1), LIMITS.searchResults)
			)
			.toArray();
	}

	read(path: string): Page {
		const page = this.find(normalizePath(path));
		if (!page) throw new VaultError(`No page at "${path}".`);
		return page;
	}

	/**
	 * Creates a page (no `expectedEtag`; fails if it exists) or overwrites one (`expectedEtag`
	 * from read; fails if the page changed since).
	 */
	write(path: string, content: string, expectedEtag?: string, by: Author = BRIAN): Page {
		return this.ctx.storage.transactionSync(() => {
			const key = normalizePath(path);
			const text = normalizeText(content);
			checkSize(text);
			const existing = this.find(key);
			if (expectedEtag === undefined && existing) {
				throw new VaultError(`"${existing.path}" already exists. Read it and pass its etag to overwrite it.`);
			}
			if (expectedEtag !== undefined && !existing) throw new VaultError(`No page at "${key}" to overwrite.`);
			if (expectedEtag !== undefined && existing && existing.etag !== expectedEtag) {
				throw new VaultError(`"${existing.path}" changed since you read it. Read it again and retry.`);
			}
			if (existing) return this.change(existing, splices(existing.content, text), by);
			const created = this.inExistingFolders(key);
			this.checkCanCreate(created);
			return this.create(created, text, by);
		});
	}

	/** Exact string replacement. `oldString` must match exactly once unless `replaceAll`. */
	edit(path: string, oldText: string, newText: string, replaceAll = false, by: Author = BRIAN): Page {
		return this.ctx.storage.transactionSync(() => {
			const page = this.read(path);
			const oldString = normalizeText(oldText);
			const newString = normalizeText(newText);
			const count = oldString ? page.content.split(oldString).length - 1 : 0;
			if (count === 0) throw new VaultError(`The text to replace was not found in "${page.path}".`);
			if (count > 1 && !replaceAll) {
				throw new VaultError(`The text to replace appears ${count} times in "${page.path}". Add context or set replace_all.`);
			}
			const replacements = replaceAll ? count : 1;
			checkSize(page.content, replacements * (newString.length - oldString.length));
			if (replacements > MAX_EXACT_SPLICES) {
				// Thousands of tiny Yjs operations are slow; one diff of the result is not.
				const content = page.content.split(oldString).join(newString);
				checkSize(content);
				return this.change(page, splices(page.content, content), by);
			}
			// The exact spots replaced, not a diff: other devices' concurrent edits merge around them.
			const list: Splice[] = [];
			let from = 0;
			let shift = 0;
			for (let i = 0; i < replacements; i++) {
				const at = page.content.indexOf(oldString, from);
				list.push({ index: at + shift, remove: oldString.length, insert: newString });
				from = at + oldString.length;
				shift += newString.length - oldString.length;
			}
			const changed = this.change(page, list, by);
			checkSize(changed.content);
			return changed;
		});
	}

	/** Renames a page, keeping its id and history. */
	move(from: string, to: string, by: Author = BRIAN): Page {
		return this.ctx.storage.transactionSync(() => {
			const page = this.read(from);
			let target = normalizePath(to);
			checkMarkdown(target);
			const clash = this.find(target);
			// Only the page itself may already answer to the target: that's a change of case.
			if (clash && clash.id !== page.id) throw new VaultError(`"${clash.path}" already exists.`);
			if (!clash) target = this.inExistingFolders(target);
			if (target === page.path) return page;
			return this.relocate(page, target, by);
		});
	}

	/** Renames a folder and everything in it, as one change. Fails if anything would clash. */
	moveFolder(from: string, to: string, by: Author = BRIAN): string[] {
		return this.ctx.storage.transactionSync(() => {
			const source = normalizePrefix(from);
			const depth = source.split('/').length - 1;
			const asked = normalizePrefix(to);
			// A change of case keeps the casing asked for; otherwise join the casing that exists.
			const recase = foldPath(asked) === foldPath(source);
			const destination = recase ? asked : this.inExistingFolders(`${asked}x`).slice(0, -1);
			if (!source || !destination) throw new VaultError('Name a folder to move, and where to.');
			if (!recase && foldPath(destination).startsWith(foldPath(source))) throw new VaultError(`Can't move "${source}" into itself.`);
			const pages = this.sql
				.exec<PageRow>(`SELECT id, path, content, etag, updated_at FROM pages WHERE substr(fold, 1, length(?1)) = ?1`, foldPath(source))
				.toArray();
			if (!pages.length) throw new VaultError(`No folder at "${source}".`);
			const moves = pages.map((row) => ({ row, target: normalizePath(destination + row.path.split('/').slice(depth).join('/')) }));
			for (const { row, target } of moves) {
				const clash = this.find(target);
				if (clash && clash.id !== row.id) throw new VaultError(`"${clash.path}" already exists.`);
			}
			return moves.map(({ row, target }) => (target === row.path ? row.path : this.relocate(this.toPage(row), target, by).path));
		});
	}

	/** Soft delete: the page moves to the trash for LIMITS.trashDays days. */
	delete(path: string, by: Author = BRIAN): void {
		this.ctx.storage.transactionSync(() => {
			const page = this.read(path);
			const cutoff = Date.now() - LIMITS.trashDays * 24 * 60 * 60 * 1000;
			this.sql.exec(`DELETE FROM trash WHERE deleted_at < ?`, cutoff);
			// A trashed page keeps its Yjs state, so a late edit from another device can still bring it back.
			this.sql.exec(
				`DELETE FROM ystate WHERE page_id NOT IN (SELECT id FROM pages) AND page_id NOT IN (SELECT page_id FROM trash WHERE page_id IS NOT NULL)`
			);
			this.sql.exec(`INSERT INTO trash (page_id, path, content, deleted_at) VALUES (?, ?, ?, ?)`, page.id, page.path, page.content, Date.now());
			this.sql.exec(`DELETE FROM pages WHERE id = ?`, page.id);
			this.sql.exec(`DELETE FROM pages_fts WHERE path = ?`, page.path);
			this.sql.exec(
				`INSERT INTO deleted (id, path, seq, deleted_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET path = excluded.path, seq = excluded.seq, deleted_at = excluded.deleted_at`,
				page.id,
				page.path,
				this.nextSeq(),
				Date.now()
			);
			this.record(page.id, 'delete', page.path, null, by);
		});
	}

	/** Pages written or deleted after `since` (0 for everything), oldest first, `limit` at a time. */
	changes(since = 0, limit: number = LIMITS.changesPerCall): Changes {
		const take = Math.min(Math.max(limit, 1), LIMITS.changesPerCall);
		const rows = this.sql
			.exec<{ seq: number; id: string; path: string; etag: string | null; deleted: number }>(
				`SELECT seq, id, path, etag, 0 AS deleted FROM pages WHERE seq > ?1
				 UNION ALL SELECT seq, id, path, NULL, 1 FROM deleted WHERE seq > ?1
				 ORDER BY seq LIMIT ?2`,
				since,
				take
			)
			.toArray();
		const changes: Change[] = rows.map((row) =>
			row.deleted
				? { seq: row.seq, id: row.id, path: row.path, deleted: true }
				: { seq: row.seq, id: row.id, path: row.path, deleted: false, etag: row.etag! }
		);
		return { changes, cursor: rows.at(-1)?.seq ?? since, more: rows.length === take };
	}

	/** A page's history, newest first. */
	history(path: string, limit = 50): HistoryEntry[] {
		const page = this.read(path);
		return this.sql
			.exec<{ action: HistoryEntry['action']; path: string; from_path: string | null; user_id: string; source: string; at: number }>(
				`SELECT action, path, from_path, user_id, source, at FROM history WHERE page_id = ? ORDER BY seq DESC LIMIT ?`,
				page.id,
				Math.min(Math.max(limit, 1), 500)
			)
			.toArray()
			.map((r) => ({ action: r.action, path: r.path, fromPath: r.from_path, user: r.user_id, source: r.source, at: r.at }));
	}

	/** Every page, plus the trash under `.trash/<deleted at>/<path>`, for export. */
	exportAll(): ExportedPage[] {
		const trash = this.sql
			.exec<{ path: string; content: string; deleted_at: number }>(`SELECT path, content, deleted_at FROM trash ORDER BY id`)
			.toArray()
			.map((row) => ({
				path: `.trash/${new Date(row.deleted_at).toISOString().replace(/:/g, '-')}/${row.path}`,
				content: row.content,
				etag: '',
				updatedAt: row.deleted_at
			}));
		const pages = this.sql
			.exec<PageRow>(`SELECT id, path, content, etag, updated_at FROM pages ORDER BY path`)
			.toArray()
			.map((row) => ({ path: row.path, content: row.content, etag: row.etag, updatedAt: row.updated_at }));
		return [...pages, ...trash];
	}

	/** Erases everything, trash and history included. Used when the account is deleted. */
	async destroy(): Promise<void> {
		// Clear the rows synchronously so the erase is visible at once, then drop the database.
		this.ctx.storage.transactionSync(() => {
			for (const table of ['pages', 'pages_fts', 'ystate', 'trash', 'deleted', 'history', 'meta']) this.sql.exec(`DELETE FROM ${table}`);
		});
		await this.ctx.storage.deleteAll();
		// This instance may keep serving until it is evicted, so leave it a valid, empty database.
		this.migrate();
	}

	/** New pages must be markdown, and the vault must have room. */
	private checkCanCreate(path: string): void {
		checkMarkdown(path);
		const count = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pages`).one().n;
		if (count >= LIMITS.pagesPerBrian) {
			throw new VaultError(`This brian is full (${LIMITS.pagesPerBrian.toLocaleString('en-US')} pages). Delete some pages to make room.`);
		}
	}

	/** The page at `path` in any casing (paths are case-insensitive), or null. */
	private find(path: string): Page | null {
		const row = this.sql
			.exec<PageRow>(`SELECT id, path, content, etag, updated_at FROM pages WHERE fold = ?`, foldPath(path))
			.toArray()[0];
		return row ? this.toPage(row) : null;
	}

	private toPage(row: PageRow): Page {
		return { id: row.id, path: row.path, content: row.content, etag: row.etag, updatedAt: row.updated_at };
	}

	/**
	 * `path` with its folders in the casing they already have ("Notes/x.md" → "notes/x.md" when
	 * notes/ exists), so a folder never splits into two that a Mac or Windows would merge.
	 */
	private inExistingFolders(path: string): string {
		const segments = path.split('/');
		for (let i = segments.length - 1; i > 0; i--) {
			const prefix = `${foldPath(segments.slice(0, i).join('/'))}/`;
			// Every folded path that starts with `prefix` sorts in [prefix, prefix with "/" → "0").
			const row = this.sql
				.exec<{ path: string }>(`SELECT path FROM pages WHERE fold >= ?1 AND fold < ?2 LIMIT 1`, prefix, `${prefix.slice(0, -1)}0`)
				.toArray()[0];
			if (row) return [...row.path.split('/').slice(0, i), ...segments.slice(i)].join('/');
		}
		return path;
	}

	/** The next change number. Never reused, even after the page that had it is gone. */
	private nextSeq(): number {
		return this.sql
			.exec<{ value: number }>(
				`INSERT INTO meta (key, value) VALUES ('seq', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1 RETURNING value`
			)
			.one().value;
	}

	private create(path: string, text: string, by: Author): Page {
		const id = `p_${crypto.randomUUID()}`;
		const doc = this.newDoc();
		doc.getText(TEXT).insert(0, text);
		this.saveDoc(id, doc);
		const page: Page = { id, path, content: text, etag: crypto.randomUUID(), updatedAt: Date.now() };
		this.sql.exec(
			`INSERT INTO pages (id, path, fold, content, etag, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id,
			path,
			foldPath(path),
			text,
			page.etag,
			page.updatedAt,
			this.nextSeq()
		);
		this.sql.exec(`INSERT INTO pages_fts (path, content) VALUES (?, ?)`, path, text);
		this.record(id, 'create', path, null, by);
		return page;
	}

	/** Applies splices to the page's Yjs document, and stores the text it now reads. */
	private change(page: Page, list: Splice[], by: Author): Page {
		if (!list.length) return page;
		const doc = this.loadDoc(page.id);
		const text = doc.getText(TEXT);
		doc.transact(() => applySplices(text, list));
		this.saveDoc(page.id, doc);
		const content = text.toString();
		const changed: Page = { ...page, content, etag: crypto.randomUUID(), updatedAt: Date.now() };
		this.sql.exec(
			`UPDATE pages SET content = ?, etag = ?, updated_at = ?, seq = ? WHERE id = ?`,
			content,
			changed.etag,
			changed.updatedAt,
			this.nextSeq(),
			page.id
		);
		this.sql.exec(`DELETE FROM pages_fts WHERE path = ?`, page.path);
		this.sql.exec(`INSERT INTO pages_fts (path, content) VALUES (?, ?)`, page.path, content);
		this.record(page.id, 'edit', page.path, null, by);
		return changed;
	}

	private relocate(page: Page, path: string, by: Author): Page {
		const moved: Page = { ...page, path, updatedAt: Date.now() };
		this.sql.exec(
			`UPDATE pages SET path = ?, fold = ?, updated_at = ?, seq = ? WHERE id = ?`,
			path,
			foldPath(path),
			moved.updatedAt,
			this.nextSeq(),
			page.id
		);
		this.sql.exec(`UPDATE pages_fts SET path = ? WHERE path = ?`, path, page.path);
		this.record(page.id, 'move', path, page.path, by);
		return moved;
	}

	/** Adds to the page's history, folding a quick run of edits by one author into one entry. */
	private record(pageId: string, action: HistoryEntry['action'], path: string, fromPath: string | null, by: Author): void {
		const now = Date.now();
		if (action === 'edit') {
			const last = this.sql
				.exec<{ seq: number; action: string; user_id: string; source: string; at: number }>(
					`SELECT seq, action, user_id, source, at FROM history WHERE page_id = ? ORDER BY seq DESC LIMIT 1`,
					pageId
				)
				.toArray()[0];
			if (last && last.action === 'edit' && last.user_id === by.user && last.source === by.source && now - last.at < HISTORY_MERGE_MS) {
				this.sql.exec(`UPDATE history SET at = ? WHERE seq = ?`, now, last.seq);
				return;
			}
		}
		this.sql.exec(
			`INSERT INTO history (page_id, action, path, from_path, user_id, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			pageId,
			action,
			path,
			fromPath,
			by.user,
			by.source,
			now
		);
	}

	private newDoc(): Y.Doc {
		const doc = new Y.Doc();
		doc.clientID = this.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'client'`).one().value;
		return doc;
	}

	private loadDoc(pageId: string): Y.Doc {
		const parts = this.sql
			.exec<{ data: ArrayBuffer }>(`SELECT data FROM ystate WHERE page_id = ? ORDER BY part`, pageId)
			.toArray()
			.map((r) => new Uint8Array(r.data));
		const state = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let offset = 0;
		for (const part of parts) {
			state.set(part, offset);
			offset += part.length;
		}
		const doc = this.newDoc();
		Y.applyUpdate(doc, state);
		return doc;
	}

	private saveDoc(pageId: string, doc: Y.Doc): void {
		const state = Y.encodeStateAsUpdate(doc);
		this.sql.exec(`DELETE FROM ystate WHERE page_id = ?`, pageId);
		for (let part = 0; part * PART_BYTES < state.length || part === 0; part++) {
			const chunk = state.slice(part * PART_BYTES, (part + 1) * PART_BYTES);
			this.sql.exec(`INSERT INTO ystate (page_id, part, data) VALUES (?, ?, ?)`, pageId, part, chunk.buffer);
		}
	}
}
