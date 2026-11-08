import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '@brian/shared';
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
	path: string;
	content: string;
	etag: string;
	updatedAt: number;
}

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

/** One entry in the change feed: a page that was written, or a path that was deleted. */
export type Change = { seq: number; path: string } & ({ deleted: false; etag: string } | { deleted: true });

export interface Changes {
	changes: Change[];
	/** Pass back as `since` to continue. */
	cursor: number;
	/** True if there may be more changes after `cursor`. */
	more: boolean;
}

/**
 * One brian's pages. A user's personal brian is the Durable Object named by their user ID; a
 * shared brian is the one named by its brian ID ("b_…"). Each has its own SQLite database, so a
 * request routed to one brian can never reach another's pages. Shared brians store paths
 * relative to their own folder, so each member can mount them under any name.
 *
 * Every write takes the next number from a per-vault counter (`seq`), and deletes leave a
 * record, so a sync client can ask for everything that changed since the last number it saw.
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
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS pages (
				path TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				etag TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				seq INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS deleted (
				path TEXT PRIMARY KEY,
				seq INTEGER NOT NULL,
				deleted_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS trash (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL,
				content TEXT NOT NULL,
				deleted_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path, content, tokenize = 'porter unicode61');
		`);
		// Vaults created before the change feed: add seq and number the existing pages.
		const hasSeq = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pragma_table_info('pages') WHERE name = 'seq'`).one().n;
		if (!hasSeq) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`ALTER TABLE pages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
				this.sql.exec(`UPDATE pages SET seq = rowid`);
				this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', (SELECT COALESCE(MAX(seq), 0) FROM pages))`);
			});
		}
		this.sql.exec(`
			CREATE INDEX IF NOT EXISTS pages_seq ON pages (seq);
			CREATE INDEX IF NOT EXISTS deleted_seq ON deleted (seq);
		`);
		const hasFold = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pragma_table_info('pages') WHERE name = 'fold'`).one().n;
		if (!hasFold) this.ctx.storage.transactionSync(() => this.repairPaths());
		this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pages_fold ON pages (fold)`);
	}

	/**
	 * One-time migration to the path rules every device can store (see `normalizePath`): adds the
	 * case-insensitive `fold` key, repairs paths stored under older rules, gives each folder one
	 * casing, renames pages that now clash to "name 2.md", and converts line endings to LF.
	 * Never deletes a page: when unsure, keep.
	 */
	private repairPaths(): void {
		this.sql.exec(`ALTER TABLE pages ADD COLUMN fold TEXT NOT NULL DEFAULT ''`);
		const rows = this.sql.exec<{ path: string; content: string }>(`SELECT path, content FROM pages ORDER BY rowid`).toArray();
		// Valid paths claim their names first, so repairing a broken path never moves a good page.
		const valid = (path: string) => repairPath(path) === path;
		rows.sort((a, b) => Number(valid(b.path)) - Number(valid(a.path)));
		// Work out every target in memory first, so no write can land on a row not yet looked at.
		const folders = new Map<string, string>(); // folded folder prefix → the casing it keeps
		const taken = new Set<string>();
		const plan = rows.map((row) => {
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
			return { ...row, target, text: normalizeText(row.content) };
		});
		const moved = plan.filter((p) => p.target !== p.path);
		for (const p of moved) this.remove(p.path);
		for (const p of plan) {
			if (p.target !== p.path || p.text !== p.content) this.put(p.target, p.text);
			else this.sql.exec(`UPDATE pages SET fold = ? WHERE path = ?`, foldPath(p.path), p.path);
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
	write(path: string, content: string, expectedEtag?: string): Page {
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
			if (existing) return this.put(existing.path, text);
			const created = this.inExistingFolders(key);
			this.checkCanCreate(created);
			return this.put(created, text);
		});
	}

	/** Exact string replacement. `oldString` must match exactly once unless `replaceAll`. */
	edit(path: string, oldText: string, newText: string, replaceAll = false): Page {
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
			const content = replaceAll ? page.content.split(oldString).join(newString) : page.content.replace(oldString, () => newString);
			checkSize(content);
			return this.put(page.path, content);
		});
	}

	move(from: string, to: string): Page {
		return this.ctx.storage.transactionSync(() => {
			const page = this.read(from);
			let target = normalizePath(to);
			checkMarkdown(target);
			const clash = this.find(target);
			// Only the page itself may already answer to the target: that's a change of case.
			if (clash && clash.path !== page.path) throw new VaultError(`"${clash.path}" already exists.`);
			if (!clash) target = this.inExistingFolders(target);
			if (target === page.path) return page;
			this.remove(page.path);
			return this.put(target, page.content);
		});
	}

	/** Soft delete: the page moves to the trash for LIMITS.trashDays days. */
	delete(path: string): void {
		this.ctx.storage.transactionSync(() => {
			const page = this.read(path);
			this.sql.exec(`DELETE FROM trash WHERE deleted_at < ?`, Date.now() - LIMITS.trashDays * 24 * 60 * 60 * 1000);
			this.sql.exec(`INSERT INTO trash (path, content, deleted_at) VALUES (?, ?, ?)`, page.path, page.content, Date.now());
			this.remove(page.path);
		});
	}

	/** Writes and deletes after `since` (0 for everything), oldest first, up to `limit` at a time. */
	changes(since = 0, limit: number = LIMITS.changesPerCall): Changes {
		const take = Math.min(Math.max(limit, 1), LIMITS.changesPerCall);
		const rows = this.sql
			.exec<{ seq: number; path: string; etag: string | null; deleted: number }>(
				`SELECT seq, path, etag, 0 AS deleted FROM pages WHERE seq > ?1
				 UNION ALL SELECT seq, path, NULL, 1 FROM deleted WHERE seq > ?1
				 ORDER BY seq LIMIT ?2`,
				since,
				take
			)
			.toArray();
		const changes: Change[] = rows.map((row) =>
			row.deleted ? { seq: row.seq, path: row.path, deleted: true } : { seq: row.seq, path: row.path, deleted: false, etag: row.etag! }
		);
		return { changes, cursor: rows.at(-1)?.seq ?? since, more: rows.length === take };
	}

	/** Every page, plus the trash under `.trash/<deleted at>/<path>`, for export. */
	exportAll(): Page[] {
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
			.exec<{ path: string; content: string; etag: string; updated_at: number }>(
				`SELECT path, content, etag, updated_at FROM pages ORDER BY path`
			)
			.toArray()
			.map((row) => ({ path: row.path, content: row.content, etag: row.etag, updatedAt: row.updated_at }));
		return [...pages, ...trash];
	}

	/** Erases everything, trash included. Used when the account is deleted. */
	async destroy(): Promise<void> {
		// Clear the rows synchronously so the erase is visible at once, then drop the database.
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM pages`);
			this.sql.exec(`DELETE FROM pages_fts`);
			this.sql.exec(`DELETE FROM trash`);
			this.sql.exec(`DELETE FROM deleted`);
			this.sql.exec(`DELETE FROM meta`);
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
		const rows = this.sql
			.exec<{ path: string; content: string; etag: string; updated_at: number }>(
				`SELECT path, content, etag, updated_at FROM pages WHERE fold = ?`,
				foldPath(path)
			)
			.toArray();
		const row = rows[0];
		return row ? { path: row.path, content: row.content, etag: row.etag, updatedAt: row.updated_at } : null;
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

	private put(path: string, content: string): Page {
		const page = { path, content, etag: crypto.randomUUID(), updatedAt: Date.now() };
		this.sql.exec(
			`INSERT INTO pages (path, fold, content, etag, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (path) DO UPDATE SET fold = excluded.fold, content = excluded.content, etag = excluded.etag,
			   updated_at = excluded.updated_at, seq = excluded.seq`,
			page.path,
			foldPath(page.path),
			page.content,
			page.etag,
			page.updatedAt,
			this.nextSeq()
		);
		this.sql.exec(`DELETE FROM deleted WHERE path = ?`, path);
		this.sql.exec(`DELETE FROM pages_fts WHERE path = ?`, path);
		this.sql.exec(`INSERT INTO pages_fts (path, content) VALUES (?, ?)`, path, content);
		return page;
	}

	private remove(path: string): void {
		this.sql.exec(`DELETE FROM pages WHERE path = ?`, path);
		this.sql.exec(`DELETE FROM pages_fts WHERE path = ?`, path);
		this.sql.exec(
			`INSERT INTO deleted (path, seq, deleted_at) VALUES (?, ?, ?)
			 ON CONFLICT (path) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at`,
			path,
			this.nextSeq(),
			Date.now()
		);
	}
}
