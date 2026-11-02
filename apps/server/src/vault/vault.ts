import { DurableObject } from 'cloudflare:workers';
import { checkSize, ftsQuery, normalizePath, normalizePrefix, VaultError } from './paths';

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
};

/**
 * One person's vault. Each user gets their own Durable Object (named by user ID) with its own
 * SQLite database, so one user's requests can never reach another's pages.
 *
 * Every method runs synchronous SQL with no awaits in between, so each call is atomic.
 */
export class Vault extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS pages (
				path TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				etag TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS trash (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL,
				content TEXT NOT NULL,
				deleted_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path, content, tokenize = 'porter unicode61');
		`);
	}

	/** Folders and files directly under a prefix, like `ls`. */
	list(prefix = ''): Listing {
		const base = normalizePrefix(prefix);
		const folders = new Set<string>();
		const files: string[] = [];
		const rows = this.sql.exec<{ path: string }>(
			`SELECT path FROM pages WHERE substr(path, 1, ?) = ? ORDER BY path`,
			base.length,
			base
		);
		for (const { path } of rows) {
			const rest = path.slice(base.length);
			const slash = rest.indexOf('/');
			if (slash === -1) files.push(path);
			else folders.add(base + rest.slice(0, slash + 1));
		}
		return { folders: [...folders], files };
	}

	/** Full-text search over paths and contents, best matches first. */
	search(query: string, limit = 20): SearchHit[] {
		const match = ftsQuery(query);
		if (!match) return [];
		return this.sql
			.exec<SearchHit>(
				`SELECT path, snippet(pages_fts, 1, '**', '**', '…', 16) AS snippet
				 FROM pages_fts WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts, 5.0, 1.0) LIMIT ?`,
				match,
				Math.min(Math.max(limit, 1), 50)
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
		checkSize(content);
		const existing = this.find(key);
		if (expectedEtag === undefined && existing) {
			throw new VaultError(`"${key}" already exists. Read it and pass its etag to overwrite it.`);
		}
		if (expectedEtag !== undefined && !existing) throw new VaultError(`No page at "${key}" to overwrite.`);
		if (expectedEtag !== undefined && existing && existing.etag !== expectedEtag) {
			throw new VaultError(`"${key}" changed since you read it. Read it again and retry.`);
		}
		return this.put(key, content);
		});
	}

	/** Exact string replacement. `oldString` must match exactly once unless `replaceAll`. */
	edit(path: string, oldString: string, newString: string, replaceAll = false): Page {
		return this.ctx.storage.transactionSync(() => {
		const page = this.read(path);
		const count = oldString ? page.content.split(oldString).length - 1 : 0;
		if (count === 0) throw new VaultError(`The text to replace was not found in "${page.path}".`);
		if (count > 1 && !replaceAll) {
			throw new VaultError(`The text to replace appears ${count} times in "${page.path}". Add context or set replace_all.`);
		}
		const content = replaceAll ? page.content.split(oldString).join(newString) : page.content.replace(oldString, () => newString);
		checkSize(content);
		return this.put(page.path, content);
		});
	}

	move(from: string, to: string): Page {
		return this.ctx.storage.transactionSync(() => {
		const page = this.read(from);
		const target = normalizePath(to);
		if (this.find(target)) throw new VaultError(`"${target}" already exists.`);
		this.remove(page.path);
		return this.put(target, page.content);
		});
	}

	/** Soft delete: the page moves to the trash and can be restored later. */
	delete(path: string): void {
		this.ctx.storage.transactionSync(() => {
		const page = this.read(path);
		this.sql.exec(`INSERT INTO trash (path, content, deleted_at) VALUES (?, ?, ?)`, page.path, page.content, Date.now());
		this.remove(page.path);
		});
	}

	private find(path: string): Page | null {
		const rows = this.sql
			.exec<{ path: string; content: string; etag: string; updated_at: number }>(
				`SELECT path, content, etag, updated_at FROM pages WHERE path = ?`,
				path
			)
			.toArray();
		const row = rows[0];
		return row ? { path: row.path, content: row.content, etag: row.etag, updatedAt: row.updated_at } : null;
	}

	private put(path: string, content: string): Page {
		const page = { path, content, etag: crypto.randomUUID(), updatedAt: Date.now() };
		this.sql.exec(
			`INSERT INTO pages (path, content, etag, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (path) DO UPDATE SET content = excluded.content, etag = excluded.etag, updated_at = excluded.updated_at`,
			page.path,
			page.content,
			page.etag,
			page.updatedAt
		);
		this.sql.exec(`DELETE FROM pages_fts WHERE path = ?`, path);
		this.sql.exec(`INSERT INTO pages_fts (path, content) VALUES (?, ?)`, path, content);
		return page;
	}

	private remove(path: string): void {
		this.sql.exec(`DELETE FROM pages WHERE path = ?`, path);
		this.sql.exec(`DELETE FROM pages_fts WHERE path = ?`, path);
	}
}
