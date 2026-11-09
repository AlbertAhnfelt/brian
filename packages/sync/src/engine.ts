import * as Y from 'yjs';
import { foldPath, normalizeText, numbered } from './paths';
import { decodeFrame, encodeFrame, MAX_PULL, type ErrorCode, type FeedEntry, type PulledPage } from './protocol';
import { setText, TEXT } from './text';

/**
 * The files of one brian on this device, with paths relative to the brian's folder ("notes/a.md").
 * The Obsidian plugin implements it on the vault; tests implement it in memory.
 */
export interface LocalFiles {
	/** Every markdown file in this brian. */
	list(): Promise<string[]>;
	/** A file's text, or null if there is no such file. */
	read(path: string): Promise<string | null>;
	/** Creates or overwrites a file, making folders as needed. */
	write(path: string, text: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	/** True while someone is typing in the file and it isn't saved yet: remote changes to it wait. */
	busy(path: string): boolean;
}

/** What the engine remembers about a page between runs. */
export interface PageRecord {
	id: string;
	path: string;
	/** The page's whole Yjs state. */
	state: Uint8Array;
	/** The file's text as the engine last saw or wrote it. Always what `state` reads. */
	text: string;
	/** A state vector of edits the server is known to have. */
	synced: Uint8Array;
	/** Local edits not yet on the server. */
	dirty: boolean;
	/** Made on this device, not yet known to the server. */
	unsent: boolean;
	/** Renamed on this device, not yet on the server. */
	moved: boolean;
	/** Why the server refused this page (too large, a name it can't store), if it did. */
	refused: string | null;
}

/** A page deleted on this device, waiting to be deleted on the server. */
export interface Tombstone {
	id: string;
	/** Its state vector when deleted: only the edits this device saw may be deleted. */
	seen: Uint8Array;
}

/** Where the engine keeps its state. The plugin uses IndexedDB; tests use memory. */
export interface SyncStore {
	/** `client`: this device's Yjs client id for the brian, if one was saved. */
	load(): Promise<{ cursor: number; pages: PageRecord[]; tombstones: Tombstone[]; client?: number }>;
	/** Saves the Yjs client id, so edits made in later runs don't each add a new client to every page. */
	setClient?(client: number): Promise<void>;
	putPage(page: PageRecord): Promise<void>;
	deletePage(id: string): Promise<void>;
	putTombstone(tombstone: Tombstone): Promise<void>;
	deleteTombstone(id: string): Promise<void>;
	setCursor(cursor: number): Promise<void>;
}

/** An open connection to the brian's Durable Object. */
export interface Connection {
	send(frame: Uint8Array): void;
	close(): void;
}

/** Opens a connection (fetching a fresh ticket first); `message` and `close` are called as things happen. */
export type Connect = (handlers: { message(frame: Uint8Array): void; close(code: number): void }) => Promise<Connection>;

export interface SyncStatus {
	state: 'offline' | 'connecting' | 'syncing' | 'synced';
	/** Pages that don't sync, and why. */
	problems: { path: string; message: string }[];
}

export interface SyncOptions {
	files: LocalFiles;
	store: SyncStore;
	connect: Connect;
	/** Viewers: never send anything; local edits last until the next update overwrites them. */
	readOnly?: boolean;
	onStatus?(status: SyncStatus): void;
	/** Waits between reconnection attempts, in ms; the last one repeats. */
	retryDelays?: number[];
	/** How often to retry writing to files that were busy, in ms. */
	busyRetryMs?: number;
}

interface Page {
	id: string;
	path: string;
	doc: Y.Doc;
	text: string;
	synced: Uint8Array;
	dirty: boolean;
	unsent: boolean;
	moved: boolean;
	refused: string | null;
	/** Remote updates held back while the file was busy. */
	held: Uint8Array[];
}

type Frame = { header: Record<string, unknown>; payloads: Uint8Array[] };

class RequestError extends Error {
	constructor(
		readonly code: ErrorCode | 'disconnected',
		message: string
	) {
		super(message);
	}
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Keeps one brian's files on this device in sync with its Durable Object.
 *
 * The rule everything rests on: **a page's Yjs document always reads exactly what's on disk**.
 * A local change is the difference between the file and the document, applied to the
 * document. A remote change is applied to the document and then written to the file. A remote
 * change to a file someone is typing in is held back until the typing has been saved: the
 * local edit goes in first, then the held changes, then the merged text is written.
 *
 * Everything that touches state runs one step at a time (`exclusive`), so file events, server
 * messages and flushing never interleave.
 */
export class BrianSync {
	private pages = new Map<string, Page>();
	/** foldPath(path) → page id. */
	private paths = new Map<string, string>();
	private tombstones = new Map<string, Uint8Array>();
	/** Files found on disk at start with no record: resolved against the server's pages after catch-up. */
	private candidates = new Map<string, string>();
	/** Pages with something to send. */
	private pending = new Set<string>();
	private cursor = 0;
	private catchingUp = false;
	private seenDuringCatchUp = 0;
	private connection: Connection | null = null;
	private requests = new Map<number, { resolve(frame: Frame): void; reject(error: Error): void }>();
	private nextRef = 0;
	private chain: Promise<unknown> = Promise.resolve();
	private stopped = false;
	private wake: (() => void) | null = null;
	private busyTimer: ReturnType<typeof setInterval> | null = null;
	private state: SyncStatus['state'] = 'offline';
	/** This device's Yjs client id for every page of the brian, kept across runs. */
	private client = 0;
	/** Cuts the wait before the next reconnection attempt short. */
	private retryNow: (() => void) | null = null;

	constructor(private options: SyncOptions) {}

	/** Loads saved state, looks for changes made while the app was closed, and starts syncing. */
	async start(): Promise<void> {
		const saved = await this.options.store.load();
		this.cursor = saved.cursor;
		this.client = saved.client ?? 0;
		if (!this.client) {
			this.client = new Y.Doc().clientID;
			await this.options.store.setClient?.(this.client);
		}
		for (const record of saved.pages) {
			const doc = this.doc(record.state);
			const page: Page = { ...record, doc, held: [] };
			this.pages.set(page.id, page);
			this.paths.set(foldPath(page.path), page.id);
			if (page.dirty || page.unsent || page.moved) this.pending.add(page.id);
		}
		for (const t of saved.tombstones) this.tombstones.set(t.id, t.seen);
		await this.exclusive(() => this.scan());
		this.busyTimer = setInterval(() => void this.exclusive(() => this.writeHeld()), this.options.busyRetryMs ?? 1000);
		void this.run();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.busyTimer) clearInterval(this.busyTimer);
		this.connection?.close();
		this.wake?.();
		this.retryNow?.();
		await this.chain;
	}

	/** Syncs now: reconnects at once if offline, otherwise sends and fetches everything. */
	syncNow(): Promise<void> {
		if (!this.connection) {
			this.retryNow?.();
			return Promise.resolve();
		}
		return this.exclusive(async () => {
			if (!this.connection) return;
			this.setState('syncing');
			try {
				await this.flush();
				await this.catchUp();
				await this.flush();
			} finally {
				if (this.connection) this.setState('synced');
			}
		});
	}

	// ---- Local events, called by the plugin as files change ----

	/** A file was created or saved. */
	fileChanged(path: string): Promise<void> {
		return this.exclusive(async () => {
			const text = await this.options.files.read(path);
			if (text === null) return;
			await this.ingest(path, normalizeText(text));
			this.flushSoon();
		});
	}

	fileDeleted(path: string): Promise<void> {
		return this.exclusive(async () => {
			const page = this.byPath(path);
			if (!page) return;
			if (this.options.readOnly) return; // The next update brings it back.
			await this.forget(page, true);
			this.flushSoon();
		});
	}

	fileRenamed(from: string, to: string): Promise<void> {
		return this.exclusive(async () => {
			const page = this.byPath(from);
			if (!page) return this.ingest(to, normalizeText((await this.options.files.read(to)) ?? ''));
			if (this.options.readOnly) return;
			this.repath(page, to);
			page.moved = true;
			page.refused = null; // A new name: try again.
			this.pending.add(page.id);
			await this.save(page);
			this.flushSoon();
		});
	}

	/** A folder was renamed: every page in it moves (Obsidian may also report each file; that's harmless). */
	folderRenamed(from: string, to: string): Promise<void> {
		return this.exclusive(async () => {
			if (this.options.readOnly) return;
			const prefix = foldPath(`${from.replace(/\/+$/, '')}/`);
			const target = `${to.replace(/\/+$/, '')}/`;
			for (const page of [...this.pages.values()]) {
				if (!foldPath(page.path).startsWith(prefix)) continue;
				this.repath(page, target + page.path.slice(prefix.length));
				page.moved = true;
				this.pending.add(page.id);
				await this.save(page);
			}
			this.flushSoon();
		});
	}

	/** A folder was deleted: every page in it is deleted. */
	folderDeleted(path: string): Promise<void> {
		return this.exclusive(async () => {
			if (this.options.readOnly) return;
			const prefix = foldPath(`${path.replace(/\/+$/, '')}/`);
			for (const page of [...this.pages.values()]) if (foldPath(page.path).startsWith(prefix)) await this.forget(page, true);
			this.flushSoon();
		});
	}

	/** Typing in a file has been saved: remote changes held back for it can be written now. */
	fileIdle(): Promise<void> {
		return this.exclusive(() => this.writeHeld());
	}

	/** Resolves once everything queued so far has been done. */
	idle(): Promise<void> {
		return this.exclusive(async () => undefined);
	}

	status(): SyncStatus {
		const problems = [...this.pages.values()].filter((p) => p.refused).map((p) => ({ path: p.path, message: p.refused! }));
		return { state: this.state, problems };
	}

	// ---- Applying local changes ----

	/** Takes a file's current text into its page: an edit, or a new page. */
	private async ingest(path: string, text: string): Promise<void> {
		const page = this.byPath(path);
		if (page) {
			if (text === page.text || this.options.readOnly) return;
			page.doc.transact(() => setText(page.doc.getText(TEXT), text));
			page.text = text;
			page.dirty = true;
			page.refused = null;
			this.pending.add(page.id);
			await this.save(page);
			return;
		}
		if (this.options.readOnly) return;
		const doc = this.doc();
		doc.getText(TEXT).insert(0, text);
		const created: Page = {
			id: `p_${crypto.randomUUID()}`,
			path,
			doc,
			text,
			synced: new Uint8Array([0]),
			dirty: false,
			unsent: true,
			moved: false,
			refused: null,
			held: []
		};
		this.pages.set(created.id, created);
		this.paths.set(foldPath(path), created.id);
		this.pending.add(created.id);
		await this.save(created);
	}

	/**
	 * At start: finds what changed on disk while the app was closed. Edited files are ingested;
	 * missing files are deletes, unless an unknown file has the same text (a rename); unknown
	 * files wait as candidates until the server's pages are known.
	 */
	private async scan(): Promise<void> {
		const files = await this.options.files.list();
		const unknown = new Map<string, string>(); // path → text
		const present = new Set<string>();
		for (const path of files) {
			const text = await this.options.files.read(path);
			if (text === null) continue;
			const page = this.byPath(path);
			if (page) {
				present.add(page.id);
				await this.ingest(path, normalizeText(text));
			} else {
				unknown.set(path, normalizeText(text));
			}
		}
		for (const page of [...this.pages.values()]) {
			if (present.has(page.id) || this.options.readOnly) continue;
			const renamed = [...unknown].find(([, text]) => text === page.text);
			if (renamed) {
				unknown.delete(renamed[0]);
				this.repath(page, renamed[0]);
				page.moved = true;
				this.pending.add(page.id);
				await this.save(page);
			} else {
				await this.forget(page, true);
			}
		}
		for (const path of unknown.keys()) this.candidates.set(foldPath(path), path);
	}

	/** Drops a page locally; `tombstone` also deletes it on the server when next connected. */
	private async forget(page: Page, tombstone: boolean): Promise<void> {
		this.pages.delete(page.id);
		this.paths.delete(foldPath(page.path));
		this.pending.delete(page.id);
		await this.options.store.deletePage(page.id);
		if (tombstone && !page.unsent) {
			const seen = Y.encodeStateVector(page.doc);
			this.tombstones.set(page.id, seen);
			await this.options.store.putTombstone({ id: page.id, seen });
		}
	}

	// ---- Applying remote changes ----

	/** A page changed on the server: apply its update and move or write its file. */
	private async applyRemote(id: string, path: string, update: Uint8Array | null): Promise<void> {
		if (!safePath(path)) return; // Never let a server path reach outside the brian's folder.
		let page = this.pages.get(id);
		if (!page) {
			if (!update) return this.pullNow([id]);
			if (this.tombstones.has(id)) return; // Deleted here; the delete is on its way.
			const doc = this.doc(update);
			const text = doc.getText(TEXT).toString();
			await this.makeRoom(path, text);
			page = { id, path, doc, text, synced: Y.encodeStateVector(doc), dirty: false, unsent: false, moved: false, refused: null, held: [] };
			this.pages.set(id, page);
			this.paths.set(foldPath(path), id);
			await this.options.files.write(path, text);
			await this.save(page);
			return;
		}
		if (path !== page.path && !page.moved) {
			await this.makeRoom(path, null, id);
			await this.options.files.rename(page.path, path);
			this.repath(page, path);
		}
		if (update) {
			page.synced = mergeVectors(page.synced, Y.encodeStateVectorFromUpdate(update));
			if (this.options.files.busy(page.path)) page.held.push(update);
			else await this.merge(page, [update]);
		}
		await this.save(page);
	}

	/** Applies remote updates to a page and writes the result, first taking in the file as it is now. */
	private async merge(page: Page, updates: Uint8Array[]): Promise<void> {
		const disk = await this.options.files.read(page.path);
		if (disk !== null && !this.options.readOnly) await this.ingest(page.path, normalizeText(disk));
		for (const update of updates) Y.applyUpdate(page.doc, update);
		const text = page.doc.getText(TEXT).toString();
		if (text !== page.text || (this.options.readOnly && disk !== text)) {
			page.text = text;
			await this.options.files.write(page.path, text);
		}
	}

	/** Writes remote changes that were held back while their files were busy. */
	private async writeHeld(): Promise<void> {
		for (const page of this.pages.values()) {
			if (!page.held.length || this.options.files.busy(page.path)) continue;
			await this.merge(page, page.held.splice(0));
			await this.save(page);
			this.flushSoon();
		}
	}

	/**
	 * A server page is about to land at `path`. Whatever sits there locally moves aside to
	 * "name 2.md", unless it's a file found at start with the very same text (then it's adopted).
	 */
	private async makeRoom(path: string, text: string | null, self?: string): Promise<void> {
		const fold = foldPath(path);
		const candidate = this.candidates.get(fold);
		if (candidate !== undefined) {
			this.candidates.delete(fold);
			const disk = await this.options.files.read(candidate);
			if (disk !== null && normalizeText(disk) === text) return; // The same page: adopt it.
			const aside = await this.freeLocalPath(candidate);
			await this.options.files.rename(candidate, aside);
			this.candidates.set(foldPath(aside), aside);
			return;
		}
		const other = this.byPath(path);
		if (other && other.id !== self) {
			// Two pages had the same name; the server has settled it, so this one steps aside.
			const aside = await this.freeLocalPath(other.path);
			await this.options.files.rename(other.path, aside);
			this.repath(other, aside);
			other.moved = true;
			this.pending.add(other.id);
			await this.save(other);
		}
	}

	private async freeLocalPath(path: string): Promise<string> {
		const taken = new Set((await this.options.files.list()).map(foldPath));
		for (const id of this.paths.values()) taken.add(foldPath(this.pages.get(id)!.path));
		for (let n = 2; ; n++) {
			const candidate = numbered(path, n);
			if (!taken.has(foldPath(candidate))) return candidate;
		}
	}

	/** A page was deleted on the server. An unsynced local edit wins: the page is sent back. */
	private async applyGone(id: string): Promise<void> {
		const page = this.pages.get(id);
		if (!page) {
			this.tombstones.delete(id);
			return this.options.store.deleteTombstone(id);
		}
		if (page.dirty && !this.options.readOnly) {
			page.unsent = true;
			this.pending.add(id);
			return this.save(page);
		}
		await this.forget(page, false);
		await this.options.files.remove(page.path);
	}

	// ---- Talking to the server ----

	private async run(): Promise<void> {
		let attempt = 0;
		const delays = this.options.retryDelays ?? [1000, 2000, 5000, 10_000, 30_000];
		while (!this.stopped) {
			const closed = new Promise<void>((resolve) => (this.wake = resolve));
			try {
				this.setState('connecting');
				this.connection = await this.options.connect({
					message: (frame) => this.receive(frame),
					close: () => this.disconnected()
				});
				attempt = 0;
				this.setState('syncing');
				await this.exclusive(async () => {
					await this.flush();
					await this.catchUp();
					await this.flush();
				});
				this.setState('synced');
				await closed;
			} catch {
				// Offline, a bad ticket, or the connection dropped mid-sync: try again shortly.
			}
			this.disconnected();
			if (this.stopped) break;
			this.setState('offline');
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, delays[Math.min(attempt++, delays.length - 1)]);
				const self = this;
				function done() {
					clearTimeout(timer);
					self.retryNow = null;
					resolve();
				}
				this.retryNow = done;
			});
		}
	}

	private disconnected(): void {
		const connection = this.connection;
		this.connection = null;
		this.catchingUp = false;
		for (const { reject } of this.requests.values()) reject(new RequestError('disconnected', 'Disconnected.'));
		this.requests.clear();
		connection?.close();
		this.wake?.();
	}

	private receive(data: Uint8Array): void {
		let frame: Frame;
		try {
			frame = decodeFrame(data);
		} catch {
			return;
		}
		const { header, payloads } = frame;
		const waiting = typeof header.ref === 'number' ? this.requests.get(header.ref) : undefined;
		if (waiting) {
			this.requests.delete(header.ref as number);
			if (header.t === 'error') waiting.reject(new RequestError(header.code as ErrorCode, String(header.message)));
			else waiting.resolve(frame);
			return;
		}
		const seq = typeof header.seq === 'number' ? header.seq : 0;
		if (header.t === 'page' && typeof header.id === 'string' && typeof header.path === 'string') {
			void this.exclusive(async () => {
				await this.applyRemote(header.id as string, header.path as string, payloads[0] ?? null);
				await this.advance(seq);
			});
		} else if (header.t === 'gone' && typeof header.id === 'string') {
			void this.exclusive(async () => {
				await this.applyGone(header.id as string);
				await this.advance(seq);
			});
		}
	}

	/** Moves the cursor forward, but only persists it once a catch-up has finished. */
	private async advance(seq: number): Promise<void> {
		if (this.catchingUp) {
			this.seenDuringCatchUp = Math.max(this.seenDuringCatchUp, seq);
		} else if (seq > this.cursor) {
			this.cursor = seq;
			await this.options.store.setCursor(seq);
		}
	}

	private request(header: Record<string, unknown>, payloads: Uint8Array[] = []): Promise<Frame> {
		const connection = this.connection;
		if (!connection) return Promise.reject(new RequestError('disconnected', 'Not connected.'));
		const ref = ++this.nextRef;
		return new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.requests.delete(ref);
				reject(new RequestError('disconnected', 'The server took too long to answer.'));
				connection.close();
			}, REQUEST_TIMEOUT_MS);
			this.requests.set(ref, {
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			});
			connection.send(encodeFrame({ ...header, ref }, payloads));
		});
	}

	/** Fetches everything that changed since the cursor and applies it. */
	private async catchUp(): Promise<void> {
		this.catchingUp = true;
		this.seenDuringCatchUp = 0;
		const latest = new Map<string, FeedEntry>();
		let since = this.cursor;
		let reset = false;
		for (let more = true; more; ) {
			const { header } = await this.request({ t: 'changes', since });
			if (typeof header.head === 'number' && header.head < since) {
				// The brian's feed is behind this device: it was reset. Compare everything from the start.
				latest.clear();
				since = this.cursor = 0;
				reset = true;
				continue;
			}
			for (const entry of header.changes as FeedEntry[]) latest.set(entry.id, entry);
			since = header.cursor as number;
			more = header.more === true;
		}
		for (const entry of latest.values()) if (entry.deleted) await this.applyGone(entry.id);
		await this.pullNow([...latest.values()].filter((e) => !e.deleted).map((e) => e.id));
		if (reset) {
			// Pages the reset brian doesn't have: this device's copy may be the only one left, so send it.
			for (const page of this.pages.values()) {
				if (latest.has(page.id)) continue;
				page.unsent = true;
				this.pending.add(page.id);
				await this.save(page);
			}
		}
		this.catchingUp = false;
		const cursor = Math.max(since, this.seenDuringCatchUp, this.cursor);
		this.cursor = cursor;
		await this.options.store.setCursor(cursor);
		// Files found at start that the server had nothing at: new pages.
		for (const path of this.candidates.values()) {
			const text = await this.options.files.read(path);
			if (text !== null) await this.ingest(path, normalizeText(text));
		}
		this.candidates.clear();
	}

	/** Pulls pages' missing edits, MAX_PULL at a time, and applies them. */
	private async pullNow(ids: string[]): Promise<void> {
		const queue = [...ids];
		while (queue.length) {
			const batch = queue.splice(0, MAX_PULL);
			const vectors = batch.map((id) => {
				const page = this.pages.get(id);
				return page ? Y.encodeStateVector(page.doc) : new Uint8Array();
			});
			const { header, payloads } = await this.request({ t: 'pull', ids: batch }, vectors);
			for (const entry of header.pages as PulledPage[]) {
				if ('later' in entry) queue.push(entry.id);
				else if ('missing' in entry) await this.applyGone(entry.id);
				else await this.applyRemote(entry.id, entry.path, payloads[entry.update]);
			}
		}
	}

	private flushSoon(): void {
		if (this.connection && !this.catchingUp && !this.options.readOnly) void this.exclusive(() => this.flush());
	}

	/** Sends local changes: deletes, then creates, moves and edits. */
	private async flush(): Promise<void> {
		if (!this.connection || this.options.readOnly) return;
		for (const [id, seen] of [...this.tombstones]) {
			try {
				await this.request({ t: 'delete', id }, [seen]);
			} catch (error) {
				if (!(error instanceof RequestError) || error.code === 'disconnected') throw error;
				// 'changed': the page has edits this device never saw, so it stays. Fetch it back.
				if (error.code === 'changed') {
					this.tombstones.delete(id);
					await this.pullNow([id]);
				}
			}
			this.tombstones.delete(id);
			await this.options.store.deleteTombstone(id);
		}
		for (const id of [...this.pending]) {
			const page = this.pages.get(id);
			if (!page) {
				this.pending.delete(id);
				continue;
			}
			try {
				await this.send(page);
				this.pending.delete(id);
			} catch (error) {
				if (!(error instanceof RequestError) || error.code === 'disconnected') throw error;
				if (error.code === 'refused' || error.code === 'bad-request') {
					page.refused = error.message;
					this.pending.delete(id);
					await this.save(page);
				} else if (error.code === 'read-only') {
					this.pending.delete(id);
				}
			}
		}
		this.options.onStatus?.(this.status());
	}

	/** Sends one page's local changes, whatever they are. */
	private async send(page: Page): Promise<void> {
		if (page.refused) return;
		if (page.unsent) {
			const vector = Y.encodeStateVector(page.doc);
			const { header } = await this.request({ t: 'create', id: page.id, path: page.path }, [Y.encodeStateAsUpdate(page.doc)]);
			page.unsent = page.dirty = page.moved = false;
			page.synced = vector;
			await this.settle(page, header);
			return;
		}
		if (page.moved) {
			try {
				const { header } = await this.request({ t: 'move', id: page.id, path: page.path });
				page.moved = false;
				await this.settle(page, header);
			} catch (error) {
				if (!(error instanceof RequestError) || error.code !== 'unknown') throw error;
				page.unsent = true; // Gone from the server meanwhile: an edit or rename wins, so send it whole.
				return this.send(page);
			}
		}
		if (page.dirty) {
			const vector = Y.encodeStateVector(page.doc);
			try {
				const { header } = await this.request({ t: 'push', id: page.id }, [Y.encodeStateAsUpdate(page.doc, page.synced)]);
				page.dirty = false;
				page.synced = vector;
				await this.settle(page, header);
			} catch (error) {
				if (!(error instanceof RequestError) || error.code !== 'unknown') throw error;
				page.unsent = true;
				return this.send(page);
			}
		}
	}

	/**
	 * After the server accepted a page: follow the path it chose. The cursor doesn't move to this
	 * change's number: another device's change with a lower number may still be on its way, and
	 * skipping past it would lose it. This change simply comes back, harmlessly, in a catch-up.
	 */
	private async settle(page: Page, header: Record<string, unknown>): Promise<void> {
		const path = header.path;
		if (typeof path === 'string' && path !== page.path && safePath(path)) {
			await this.options.files.rename(page.path, path);
			this.repath(page, path);
		}
		await this.save(page);
	}

	// ---- Bookkeeping ----

	/** A page's Yjs document, using this device's client id for its own edits. */
	private doc(state?: Uint8Array): Y.Doc {
		const doc = new Y.Doc();
		if (state) Y.applyUpdate(doc, state);
		// After applying: a remote update with this client's own edits would otherwise make Yjs pick a new id.
		if (this.client) doc.clientID = this.client;
		return doc;
	}

	private byPath(path: string): Page | undefined {
		const id = this.paths.get(foldPath(path));
		return id ? this.pages.get(id) : undefined;
	}

	private repath(page: Page, path: string): void {
		this.paths.delete(foldPath(page.path));
		page.path = path;
		this.paths.set(foldPath(path), page.id);
	}

	private save(page: Page): Promise<void> {
		return this.options.store.putPage({
			id: page.id,
			path: page.path,
			state: Y.encodeStateAsUpdate(page.doc),
			text: page.text,
			synced: page.synced,
			dirty: page.dirty,
			unsent: page.unsent,
			moved: page.moved,
			refused: page.refused
		});
	}

	private setState(state: SyncStatus['state']): void {
		this.state = state;
		this.options.onStatus?.(this.status());
	}

	/** Runs `fn` after everything queued before it, never two at once. Errors don't break the queue. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.chain.then(fn);
		this.chain = result.catch(() => undefined);
		return result;
	}
}

/** Only plain relative paths inside the brian's folder: no "..", no leading "/" or ".", no backslashes. */
function safePath(path: string): boolean {
	if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
	return path.split('/').every((segment) => segment && segment !== '..' && !segment.startsWith('.'));
}

/** The larger clock for every client in either state vector. */
function mergeVectors(a: Uint8Array, b: Uint8Array): Uint8Array {
	const merged = Y.decodeStateVector(a);
	for (const [client, clock] of Y.decodeStateVector(b)) merged.set(client, Math.max(merged.get(client) ?? 0, clock));
	return Y.encodeStateVector(merged);
}
