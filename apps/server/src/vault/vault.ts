import { DurableObject } from 'cloudflare:workers';
import { LIMITS, loginAllowed, withRules } from '@brian/shared';
import {
	applySplices,
	decodeFrame,
	encodeFrame,
	MAX_PULL,
	PAGE_ID,
	splices,
	TEXT,
	type ErrorCode,
	type FeedEntry,
	type PulledPage,
	type Reply,
	type Role,
	type Splice
} from '@brian/sync';
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
	action: 'create' | 'edit' | 'move' | 'delete' | 'restore';
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
const SCHEMA = 3;
/** Sync tickets work once, within this long of being issued. */
const TICKET_MS = 60 * 1000;
/** Largest Yjs state a page may grow to (its text is capped at LIMITS.pageBytes). */
const MAX_STATE_BYTES = 8 * 1024 * 1024;
/** A pull answer stops adding pages past this many bytes; the rest are marked `later`. */
const PULL_BYTES = 4 * 1024 * 1024;

/** A device connected over a WebSocket, as stored on its socket (survives hibernation). */
interface Session {
	user: string;
	email: string;
	source: string;
	role: Role;
}

/** A sync request refused with a protocol error code. */
class SyncError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string
	) {
		super(message);
	}
}
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
			else if (version === 1) this.upgradeFromV1();
			else this.addTickets();
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
		this.addTickets();
		// This vault's Yjs client id. Writes run one at a time, after loading the latest state,
		// so one id serves every server-side edit and keeps the documents' version vectors small.
		this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('client', ?)`, crypto.getRandomValues(new Uint32Array(1))[0] || 1);
	}

	/** Schema 3: one-time tickets that let a device open a sync WebSocket. */
	private addTickets(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS tickets (
				hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				email TEXT NOT NULL,
				source TEXT NOT NULL,
				role TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
		`);
		this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`, SCHEMA);
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
		return this.commit(() => {
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
		return this.commit(() => {
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
		return this.commit(() => {
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
		return this.commit(() => this.moveFolderInside(from, to, by, false));
	}

	/** Moves a folder; on a clash either refuses (MCP) or numbers the page "name 2.md" (sync). */
	private moveFolderInside(from: string, to: string, by: Author, number: boolean): string[] {
		{
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
			if (!number) {
				for (const { row, target } of moves) {
					const clash = this.find(target);
					if (clash && clash.id !== row.id) throw new VaultError(`"${clash.path}" already exists.`);
				}
			}
			return moves.map(({ row, target }) => {
				const free = number ? this.freePath(target, row.id) : target;
				return free === row.path ? row.path : this.relocate(this.toPage(row), free, by).path;
			});
		}
	}

	/** Soft delete: the page moves to the trash for LIMITS.trashDays days. */
	delete(path: string, by: Author = BRIAN): void {
		this.commit(() => this.trashPage(this.read(path), by));
	}

	private trashPage(page: Page, by: Author): void {
		{
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
			this.emit({ t: 'gone', id: page.id, seq: this.currentSeq() });
		}
	}

	/**
	 * Keeps Brian's block of the root BRIAN.md set to `block` (see `withRules`), creating the page if
	 * there is none. Only acts when the block differs from the last one written, so a page the user
	 * deleted stays deleted until the rules change. Never touches the rest of the page.
	 */
	ensureRules(block: string): boolean {
		const hash = fnv1a(block);
		if (this.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'rules'`).toArray()[0]?.value === hash) return false;
		return this.commit(() => {
			const existing = this.find('BRIAN.md');
			const content = withRules(existing?.content ?? null, normalizeText(block));
			this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('rules', ?)`, hash);
			if (existing) {
				checkSize(content);
				return this.change(existing, splices(existing.content, content), BRIAN) !== existing;
			}
			this.checkCanCreate('BRIAN.md');
			this.create('BRIAN.md', content, BRIAN);
			return true;
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
			for (const table of ['pages', 'pages_fts', 'ystate', 'trash', 'deleted', 'history', 'tickets', 'meta']) this.sql.exec(`DELETE FROM ${table}`);
		});
		for (const ws of this.ctx.getWebSockets()) ws.close(4004, 'This brian was deleted.');
		await this.ctx.storage.deleteAll();
		// This instance may keep serving until it is evicted, so leave it a valid, empty database.
		this.migrate();
	}

	// ---- Sync: devices connected over WebSockets (protocol in @brian/sync) ----

	/** Messages for other devices, sent once the transaction that produced them commits. */
	private outbox: Uint8Array[] = [];
	/** The socket whose request is being handled: it hears back through its reply, not a broadcast. */
	private origin: WebSocket | null = null;

	/**
	 * A one-time ticket that lets `user` open a sync WebSocket to this brian within a minute.
	 * Only its hash is stored. The caller has already checked the user's role in this brian.
	 */
	async issueTicket(user: string, email: string, source: string, role: Role): Promise<string> {
		const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const hash = await sha256(secret);
		this.sql.exec(`DELETE FROM tickets WHERE expires_at < ?`, Date.now());
		this.sql.exec(
			`INSERT INTO tickets (hash, user_id, email, source, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
			hash,
			user,
			email,
			source,
			role,
			Date.now() + TICKET_MS
		);
		return secret;
	}

	/** Opens a sync WebSocket for the holder of a valid ticket (`?ticket=<name>.<secret>`). */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
		const secret = new URL(request.url).searchParams.get('ticket')?.split('.').pop() ?? '';
		const hash = await sha256(secret);
		// Looked up and spent in one synchronous step, so a ticket can't open two sockets.
		const row = this.sql
			.exec<{ user_id: string; email: string; source: string; role: Role }>(
				`DELETE FROM tickets WHERE hash = ? AND expires_at >= ? RETURNING user_id, email, source, role`,
				hash,
				Date.now()
			)
			.toArray()[0];
		if (!row) return new Response('This sync ticket is invalid or has expired.', { status: 401 });
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ user: row.user_id, email: row.email, source: row.source, role: row.role } satisfies Session);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Closes a user's sockets, e.g. when they leave the brian or their role changes. */
	kick(user: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if ((ws.deserializeAttachment() as Session).user === user) ws.close(4003, 'Your membership changed. Reconnect.');
		}
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		let ref = 0;
		try {
			if (typeof message === 'string') throw new SyncError('bad-request', 'Send binary frames.');
			let frame: ReturnType<typeof decodeFrame>;
			try {
				frame = decodeFrame(message);
			} catch (error) {
				throw new SyncError('bad-request', (error as Error).message);
			}
			ref = Number.isSafeInteger(frame.header.ref) ? (frame.header.ref as number) : 0;
			const session = ws.deserializeAttachment() as Session;
			// Dev's allowlist: an email taken off it stops syncing at its next message.
			if (!loginAllowed(this.env, session.email)) {
				ws.close(4003, 'Not allowed.');
				return;
			}
			this.origin = ws;
			const [reply, payloads] = this.handle(session, frame.header, frame.payloads);
			ws.send(encodeFrame({ t: 'ok', ref, ...reply }, payloads));
		} catch (error) {
			const code: ErrorCode = error instanceof SyncError ? error.code : error instanceof VaultError ? 'refused' : 'bad-request';
			if (!(error instanceof SyncError || error instanceof VaultError)) console.error('sync request failed', error);
			ws.send(encodeFrame({ t: 'error', ref, code, message: (error as Error).message } satisfies Reply));
		} finally {
			this.origin = null;
		}
	}

	webSocketClose(ws: WebSocket, code: number): void {
		try {
			ws.close(code === 1005 ? 1000 : code, 'Closed.');
		} catch {
			// Already closed.
		}
	}

	/** Handles one request from a device; returns the fields and payloads of its `ok` reply. */
	private handle(session: Session, header: Record<string, unknown>, payloads: Uint8Array[]): [Record<string, unknown>, Uint8Array[]?] {
		const by: Author = { user: session.user, source: session.source };
		const str = (name: string): string => {
			const value = header[name];
			if (typeof value !== 'string' || !value) throw new SyncError('bad-request', `"${name}" must be a non-empty string.`);
			return value;
		};
		const pageId = (): string => {
			const id = str('id');
			if (!PAGE_ID.test(id)) throw new SyncError('bad-request', 'Page ids are "p_" and a UUID.');
			return id;
		};
		const payload = (): Uint8Array => {
			if (payloads.length !== 1) throw new SyncError('bad-request', 'Expected exactly one payload.');
			return payloads[0];
		};
		if (header.t === 'changes') {
			const since = header.since;
			if (!Number.isSafeInteger(since) || (since as number) < 0) throw new SyncError('bad-request', '"since" must be a change number.');
			const { changes, cursor, more } = this.changes(since as number);
			const entries: FeedEntry[] = changes.map(({ seq, id, path, deleted }) => ({ seq, id, path, deleted }));
			// head: a device whose cursor is past it knows this brian was reset, and compares everything.
			return [{ changes: entries, cursor, more, head: this.currentSeq() }];
		}
		if (header.t === 'pull') return this.pull(header.ids, payloads);
		if (session.role === 'viewer') throw new SyncError('read-only', "You're a viewer of this brian, so your changes don't sync.");
		switch (header.t) {
			case 'push': {
				const id = pageId();
				const update = payload();
				const page = this.commit(() => {
					const existing = this.byId(id);
					if (existing) return this.applyUpdate(existing, update, by);
					const restored = this.restore(id, update, by);
					if (!restored) throw new SyncError('unknown', 'No such page: send it whole with "create".');
					return restored;
				});
				return [{ seq: this.currentSeq(), path: page.path }];
			}
			case 'create': {
				const id = pageId();
				const path = str('path');
				const state = payload();
				const page = this.commit(() => {
					// A retry of a create that already landed, or a page that came back: just merge.
					const existing = this.byId(id);
					if (existing) return this.applyUpdate(existing, state, by);
					const restored = this.restore(id, state, by);
					if (restored) return restored;
					const key = normalizePath(path);
					checkMarkdown(key);
					const target = this.freePath(this.inExistingFolders(key));
					this.checkCanCreate(target);
					return this.create(target, '', by, { id, state });
				});
				return [{ seq: this.currentSeq(), path: page.path }];
			}
			case 'move': {
				const id = pageId();
				const path = str('path');
				const page = this.commit(() => {
					const existing = this.byId(id);
					if (!existing) throw new SyncError('unknown', 'No such page.');
					const key = normalizePath(path);
					checkMarkdown(key);
					const clash = this.find(key);
					// Last rename wins; onto another page's path, it becomes "name 2.md".
					const target = clash?.id === id ? key : this.freePath(this.inExistingFolders(key), id);
					return target === existing.path ? existing : this.relocate(existing, target, by);
				});
				return [{ seq: this.currentSeq(), path: page.path }];
			}
			case 'moveFolder': {
				const from = str('from');
				const to = str('to');
				this.commit(() => this.moveFolderInside(from, to, by, true));
				return [{ seq: this.currentSeq() }];
			}
			case 'delete': {
				const id = pageId();
				const seen = payload();
				this.commit(() => {
					const page = this.byId(id);
					if (!page) return; // Already gone: deleting twice is fine.
					if (this.hasUnseen(id, seen)) throw new SyncError('changed', 'This page has edits you never saw, so it was kept.');
					this.trashPage(page, by);
				});
				return [{ seq: this.currentSeq() }];
			}
			default:
				throw new SyncError('bad-request', 'Unknown request.');
		}
	}

	/** Answers a pull: for each page, the edits missing from the state vector the device sent. */
	private pull(ids: unknown, vectors: Uint8Array[]): [Record<string, unknown>, Uint8Array[]] {
		if (!Array.isArray(ids) || ids.length > MAX_PULL || !ids.every((id) => typeof id === 'string' && PAGE_ID.test(id))) {
			throw new SyncError('bad-request', `"ids" must list up to ${MAX_PULL} page ids.`);
		}
		if (vectors.length !== ids.length) throw new SyncError('bad-request', 'Send one state vector per id.');
		const pages: PulledPage[] = [];
		const updates: Uint8Array[] = [];
		let bytes = 0;
		ids.forEach((id: string, i) => {
			const row = this.sql.exec<{ path: string; seq: number }>(`SELECT path, seq FROM pages WHERE id = ?`, id).toArray()[0];
			if (!row) return pages.push({ id, missing: true });
			if (bytes > PULL_BYTES) return pages.push({ id, later: true });
			let update: Uint8Array;
			try {
				update = vectors[i].length ? Y.encodeStateAsUpdate(this.loadDoc(id), vectors[i]) : Y.encodeStateAsUpdate(this.loadDoc(id));
			} catch {
				throw new SyncError('bad-request', `The state vector for ${id} is malformed.`);
			}
			bytes += update.length;
			pages.push({ id, path: row.path, seq: row.seq, update: updates.length });
			updates.push(update);
		});
		return [{ pages }, updates];
	}

	/** True if the page holds edits beyond the state vector `seen` (a device's view of it). */
	private hasUnseen(id: string, seen: Uint8Array): boolean {
		let device: Map<number, number>;
		try {
			device = Y.decodeStateVector(seen);
		} catch {
			throw new SyncError('bad-request', 'That state vector is malformed.');
		}
		const server = Y.decodeStateVector(Y.encodeStateVector(this.loadDoc(id)));
		for (const [client, clock] of server) if ((device.get(client) ?? 0) < clock) return true;
		return false;
	}

	private byId(id: string): Page | null {
		const row = this.sql.exec<PageRow>(`SELECT id, path, content, etag, updated_at FROM pages WHERE id = ?`, id).toArray()[0];
		return row ? this.toPage(row) : null;
	}

	/** Runs a write in a transaction, then tells connected devices what changed. */
	private commit<T>(fn: () => T): T {
		this.outbox = [];
		try {
			const result = this.ctx.storage.transactionSync(fn);
			for (const ws of this.ctx.getWebSockets()) {
				if (ws === this.origin) continue;
				for (const frame of this.outbox) {
					try {
						ws.send(frame);
					} catch {
						// A socket closing mid-send catches up with `changes` when it reconnects.
					}
				}
			}
			return result;
		} finally {
			this.outbox = [];
		}
	}

	/** Queues a message for the other devices (only if any are connected). */
	private emit(message: Reply, payloads: Uint8Array[] = []): void {
		if (this.ctx.getWebSockets().length) this.outbox.push(encodeFrame(message, payloads));
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

	/** The last change number given out, 0 before the first change. */
	private currentSeq(): number {
		return this.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'seq'`).toArray()[0]?.value ?? 0;
	}

	/** The next change number. Never reused, even after the page that had it is gone. */
	private nextSeq(): number {
		return this.sql
			.exec<{ value: number }>(
				`INSERT INTO meta (key, value) VALUES ('seq', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1 RETURNING value`
			)
			.one().value;
	}

	/** Creates a page from text (MCP), or from a device's Yjs state under the device's id (sync). */
	private create(path: string, text: string, by: Author, from?: { id: string; state: Uint8Array }): Page {
		const id = from?.id ?? `p_${crypto.randomUUID()}`;
		const doc = this.newDoc();
		if (from) {
			this.applyTo(doc, from.state);
			text = doc.getText(TEXT).toString();
			checkSize(text);
		} else {
			doc.getText(TEXT).insert(0, text);
		}
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
		this.emit({ t: 'page', id, path, seq: this.currentSeq() }, [Y.encodeStateAsUpdate(doc)]);
		return page;
	}

	/** Applies splices to the page's Yjs document, and stores the text it now reads. */
	private change(page: Page, list: Splice[], by: Author): Page {
		if (!list.length) return page;
		const doc = this.loadDoc(page.id);
		const before = Y.encodeStateVector(doc);
		doc.transact(() => applySplices(doc.getText(TEXT), list));
		return this.store(page, doc, before, by);
	}

	/** Applies a device's Yjs update to a page. */
	private applyUpdate(page: Page, update: Uint8Array, by: Author): Page {
		const doc = this.loadDoc(page.id);
		const before = Y.encodeStateVector(doc);
		this.applyTo(doc, update);
		return this.store(page, doc, before, by);
	}

	/** Saves an edited Yjs document and the text it now reads, and tells other devices. */
	private store(page: Page, doc: Y.Doc, before: Uint8Array, by: Author): Page {
		const content = doc.getText(TEXT).toString();
		checkSize(content);
		const grew = !sameBytes(before, Y.encodeStateVector(doc));
		this.saveDoc(page.id, doc);
		if (content === page.content && !grew) return page;
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
		this.emit({ t: 'page', id: page.id, path: page.path, seq: this.currentSeq() }, [Y.encodeStateAsUpdate(doc, before)]);
		return changed;
	}

	/**
	 * Brings a trashed page back because a device edited it: an edit beats a delete. It returns
	 * to its old path, or "name 2.md" if that's been taken since.
	 */
	private restore(id: string, update: Uint8Array, by: Author): Page | null {
		const trashed = this.sql
			.exec<{ path: string }>(`SELECT path FROM trash WHERE page_id = ? ORDER BY id DESC LIMIT 1`, id)
			.toArray()[0];
		if (!trashed || !this.hasDoc(id)) return null;
		const path = this.freePath(this.inExistingFolders(trashed.path));
		this.checkCanCreate(path);
		const doc = this.loadDoc(id);
		this.applyTo(doc, update);
		const content = doc.getText(TEXT).toString();
		checkSize(content);
		this.saveDoc(id, doc);
		const page: Page = { id, path, content, etag: crypto.randomUUID(), updatedAt: Date.now() };
		this.sql.exec(
			`INSERT INTO pages (id, path, fold, content, etag, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id,
			path,
			foldPath(path),
			content,
			page.etag,
			page.updatedAt,
			this.nextSeq()
		);
		this.sql.exec(`INSERT INTO pages_fts (path, content) VALUES (?, ?)`, path, content);
		this.sql.exec(`DELETE FROM trash WHERE page_id = ?`, id);
		this.sql.exec(`DELETE FROM deleted WHERE id = ?`, id);
		this.record(id, 'restore', path, null, by);
		this.emit({ t: 'page', id, path, seq: this.currentSeq() }, [Y.encodeStateAsUpdate(doc)]);
		return page;
	}

	/** `path` if it's free (or already this page's), otherwise the first free "name n.md". */
	private freePath(path: string, self?: string): string {
		let candidate = path;
		for (let n = 2; ; n++) {
			const clash = this.find(candidate);
			if (!clash || clash.id === self) return candidate;
			candidate = numbered(path, n);
		}
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
		this.emit({ t: 'page', id: page.id, path, seq: this.currentSeq() });
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

	private hasDoc(pageId: string): boolean {
		return this.sql.exec(`SELECT 1 FROM ystate WHERE page_id = ? LIMIT 1`, pageId).toArray().length > 0;
	}

	/** Applies a Yjs update from a device, refusing malformed ones. */
	private applyTo(doc: Y.Doc, update: Uint8Array): void {
		try {
			Y.applyUpdate(doc, update);
		} catch {
			throw new SyncError('bad-request', 'That Yjs update is malformed.');
		}
	}

	private saveDoc(pageId: string, doc: Y.Doc): void {
		const state = Y.encodeStateAsUpdate(doc);
		if (state.length > MAX_STATE_BYTES) throw new VaultError('This page has grown too large to store.');
		this.sql.exec(`DELETE FROM ystate WHERE page_id = ?`, pageId);
		for (let part = 0; part * PART_BYTES < state.length || part === 0; part++) {
			const chunk = state.slice(part * PART_BYTES, (part + 1) * PART_BYTES);
			this.sql.exec(`INSERT INTO ystate (page_id, part, data) VALUES (?, ?, ?)`, pageId, part, chunk.buffer);
		}
	}
}

/** A 32-bit FNV-1a hash, to tell whether a text changed without storing it. */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	return hash >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
