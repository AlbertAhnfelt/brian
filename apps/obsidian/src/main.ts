import { LIMITS } from '@brian/shared/limits';
import { BrianSync, foldPath, numbered, repairPath, type Connect, type SyncBrian, type SyncSession, type SyncStatus } from '@brian/sync';
import { App, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
import { finishSignIn, refresh, register, SignedOut, startSignIn, type PendingSignIn, type Tokens } from './auth';
import { VaultFiles } from './files';
import { cannotInstall, otherSyncTool } from './guards';
import { IdbStore } from './store';

interface Settings {
	server: string;
	clientId: string | null;
	tokens: Tokens | null;
	pending: PendingSignIn | null;
	/** Names this install's IndexedDB databases. */
	installId: string;
	/** True once the first sync has started: the install checks only run before it. */
	installed: boolean;
	/** The username this vault last synced with: signing back in as them skips the install checks. */
	account: string | null;
	/** Shared brian id → the folder under brian/ it lives in on this device, as last agreed with Brian. */
	roots: Record<string, string>;
}

const DEFAULTS: Settings = {
	server: 'https://mybrian.dev',
	clientId: null,
	tokens: null,
	pending: null,
	installId: '',
	installed: false,
	account: null,
	roots: {}
};

/** How often to look for brians joined or left elsewhere (the website, another device). */
const RECONCILE_MS = 5 * 60 * 1000;
/** How long a file delete in a shared brian waits, to tell it apart from the whole folder going. */
const DELETE_WAIT_MS = 400;

interface Running {
	brian: SyncBrian;
	files: VaultFiles;
	engine: BrianSync;
	status: SyncStatus;
}

const keyOf = (brian: { id: string | null }) => brian.id ?? 'personal';
const folderOf = (root: string) => root.replace(/\/$/, '');

export default class BrianPlugin extends Plugin {
	settings: Settings = { ...DEFAULTS };
	/** Brian key ("personal" or the shared brian's id) → its running engine. */
	private running = new Map<string, Running>();
	/** Vault path → last keystroke, so remote changes wait while someone types. */
	private typing = new Map<string, number>();
	private statusBar: HTMLElement | null = null;
	/** Why sync isn't running, shown in the status bar and settings. */
	problem: string | null = null;
	private starting = false;
	/** Folders of the shared brians ("brian/acme/"), known before any brian starts, so the personal brian never takes them. */
	private mountList: string[] = [];
	/** Folders of brians just left, kept out of the personal brian while they go to the trash. */
	private leaving = new Set<string>();
	/** Shared brians whose folder rename is being settled with Brian. */
	private moving = new Set<string>();
	/** Refusals already shown as a notice. */
	private told = new Set<string>();
	private lastSync = 0;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
		this.settings.roots ??= {};
		if (!this.settings.installId) {
			this.settings.installId = crypto.randomUUID();
			await this.saveSettings();
		}
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass('mod-clickable');
		this.statusBar.onClickEvent(() => this.openSettings());
		this.addSettingTab(new BrianSettingTab(this.app, this));
		this.registerObsidianProtocolHandler('brian-auth', (params) => void this.completeSignIn(params));
		this.addCommand({ id: 'sign-in', name: 'Sign in', callback: () => void this.signIn() });
		this.addCommand({ id: 'sign-out', name: 'Sign out and stop syncing', callback: () => void this.signOut() });
		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
		this.addCommand({ id: 'reconnect', name: 'Reconnect', callback: () => void this.restart() });

		this.registerEvent(
			this.app.workspace.on('editor-change', (_editor, info) => {
				if (info.file) this.typing.set(info.file.path, Date.now());
			})
		);
		this.registerEvent(this.app.vault.on('create', (file) => this.changed(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.changed(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.deleted(file)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.renamed(file, oldPath)));
		this.registerInterval(window.setInterval(() => void this.reconcile(), RECONCILE_MS));
		// Phones drop connections in the background: sync as soon as the app is back.
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible' && Date.now() - this.lastSync > 10_000) void this.syncNow();
		});
		this.registerDomEvent(window, 'online', () => void this.syncNow());
		// Files are only all known once the layout is ready; events before that are the vault loading.
		this.app.workspace.onLayoutReady(() => void this.start());
		this.render();
	}

	async onunload(): Promise<void> {
		await this.stopAll();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ---- Signing in ----

	async signIn(): Promise<void> {
		try {
			this.settings.clientId ??= await register(this.settings.server);
			const { url, pending } = await startSignIn(this.settings.server, this.settings.clientId);
			this.settings.pending = pending;
			await this.saveSettings();
			window.open(url);
		} catch (error) {
			new Notice(`Brian: ${(error as Error).message}`);
		}
	}

	private async completeSignIn(params: Record<string, string>): Promise<void> {
		const pending = this.settings.pending;
		if (!pending) return void new Notice('Brian: no sign-in was in progress. Start again from the settings.');
		try {
			this.settings.tokens = await finishSignIn(this.settings.server, pending, params);
			this.settings.pending = null;
			await this.saveSettings();
			new Notice('Brian: signed in.');
			await this.restart();
		} catch (error) {
			new Notice(`Brian: ${(error as Error).message}`);
		}
	}

	/** Stops syncing and forgets this device's sync state; the notes stay. Signing back in merges again. */
	async signOut(reason?: string): Promise<void> {
		const keys = new Set([...this.running.keys(), 'personal', ...Object.keys(this.settings.roots)]);
		await this.stopAll();
		for (const key of keys) await IdbStore.destroy(this.storeName(key));
		this.settings.tokens = null;
		this.settings.installed = false;
		this.settings.roots = {};
		await this.saveSettings();
		this.problem = reason ?? null;
		if (reason) new Notice(`Brian: ${reason}`, 15_000);
		this.render();
	}

	/** A valid access token, refreshed when it's about to expire. */
	private async accessToken(): Promise<string> {
		const tokens = this.settings.tokens;
		if (!tokens || !this.settings.clientId) throw new SignedOut('Not signed in.');
		if (tokens.expiresAt - Date.now() > 60_000) return tokens.access;
		this.settings.tokens = await refresh(this.settings.server, this.settings.clientId, tokens);
		await this.saveSettings();
		return this.settings.tokens.access;
	}

	/** An authorized POST to Brian, refreshing the token once if Brian says it's stale. */
	private async post(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
		const send = async () =>
			requestUrl({
				url: `${this.settings.server}${path}`,
				method: 'POST',
				headers: { Authorization: `Bearer ${await this.accessToken()}` },
				...(body === undefined ? {} : { contentType: 'application/json', body: JSON.stringify(body) }),
				throw: false
			});
		let response = await send();
		if (response.status === 401 && this.settings.tokens) {
			this.settings.tokens.expiresAt = 0; // Refresh once; still refused means signed out.
			response = await send();
			if (response.status === 401) throw new SignedOut('Signed out: sign in to Brian again.');
		}
		let json: Record<string, unknown> | null = null;
		try {
			json = response.json as Record<string, unknown>;
		} catch {
			// Not JSON.
		}
		return { status: response.status, json };
	}

	/** Tickets from Brian: for every brian, or just one ("personal" or a shared brian's id). */
	private async session(only?: string): Promise<SyncSession> {
		const response = await this.post(`/mcp/sync${only ? `?brian=${encodeURIComponent(only)}` : ''}`);
		if (response.status !== 200) throw new Error(String(response.json?.error ?? `Brian answered ${response.status}.`));
		return response.json as unknown as SyncSession;
	}

	/** Runs `fn`; if Brian says the sign-in is gone, signs out, says so, and returns null. */
	private async signedIn<T>(fn: () => Promise<T>): Promise<T | null> {
		try {
			return await fn();
		} catch (error) {
			if (!(error instanceof SignedOut)) throw error;
			if (this.settings.tokens) await this.signOut('Signed out: sign in again in the Brian settings to keep syncing.');
			return null;
		}
	}

	// ---- Running the sync ----

	async restart(): Promise<void> {
		await this.stopAll();
		await this.start();
	}

	/** Sends and fetches everything now, and picks up brians joined or left. */
	async syncNow(): Promise<void> {
		this.lastSync = Date.now();
		if (!this.running.size) return this.start();
		await this.reconcile();
		await Promise.all([...this.running.values()].map((r) => r.engine.syncNow().catch(() => undefined)));
	}

	private async start(): Promise<void> {
		if (this.starting || this.running.size) return;
		this.starting = true;
		try {
			this.problem = this.settings.tokens ? otherSyncTool(this.app) : 'Sign in to start syncing.';
			if (this.problem) {
				// Say why out loud: a sync that silently doesn't run looks like a broken one.
				if (this.settings.tokens) new Notice(`Brian isn't syncing. ${this.problem}`, 15_000);
				return;
			}
			let session: SyncSession | null;
			try {
				session = await this.signedIn(() => this.session());
			} catch (error) {
				this.problem = `Can't reach Brian (${(error as Error).message}). Trying again in a few minutes, or use Sync now.`;
				return;
			}
			if (!session) return;
			// Signing back in as the same person isn't a new install: the vault already is their Brian.
			if (!this.settings.installed && session.username !== this.settings.account) {
				this.problem = cannotInstall(this.app, LIMITS.pagesPerBrian);
				if (this.problem) return void new Notice(`Brian isn't syncing. ${this.problem}`, 15_000);
			}
			if (!this.settings.installed || this.settings.account !== session.username) {
				this.settings.installed = true;
				this.settings.account = session.username;
				await this.saveSettings();
			}
			// Before anything starts, so the personal brian never takes a shared brian's files as its own.
			await this.prepareFolders(session);
			for (const brian of session.brians) await this.run(brian);
		} finally {
			this.starting = false;
			this.render();
		}
	}

	private rootOf(brian: SyncBrian): string {
		return brian.id ? `brian/${this.settings.roots[brian.id] ?? brian.mount}/` : '';
	}

	private async run(brian: SyncBrian): Promise<void> {
		const key = keyOf(brian);
		const files = new VaultFiles(this.app, this.rootOf(brian), () => (brian.id ? [] : this.mounts()), this.typing);
		const running: Running = { brian, files, engine: null as unknown as BrianSync, status: { state: 'connecting', problems: [] } };
		running.engine = new BrianSync({
			files,
			store: new IdbStore(this.storeName(key)),
			connect: this.connector(key, brian),
			readOnly: brian.role === 'viewer',
			onStatus: (status) => {
				running.status = status;
				this.tellRefusals(running);
				this.render();
			}
		});
		this.running.set(key, running);
		await running.engine.start();
	}

	/** Opens a WebSocket for one brian, with a fresh ticket each time. */
	private connector(key: string, brian: SyncBrian): Connect {
		let first: string | null = brian.ticket;
		return async ({ message, close }) => {
			const ticket = first ?? (await this.signedIn(() => this.session(key)))?.brians[0]?.ticket;
			first = null;
			if (!ticket) {
				void this.reconcile(); // Signed out, or no longer a member: stop syncing this brian.
				throw new Error('No ticket.');
			}
			const url = new URL('/sync/socket', this.settings.server);
			url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
			url.searchParams.set('ticket', ticket);
			const ws = new WebSocket(url.toString());
			ws.binaryType = 'arraybuffer';
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error('Could not connect.'));
			});
			ws.onmessage = (event) => message(new Uint8Array(event.data as ArrayBuffer));
			ws.onclose = (event) => {
				close(event.code);
				if (event.code === 4003) void this.reconcile(); // Membership changed.
			};
			return { send: (frame) => ws.send(frame as Uint8Array<ArrayBuffer>), close: () => ws.close() };
		};
	}

	/** Starts brians joined elsewhere, stops ones left (their folder goes to the trash), follows role and folder changes. */
	private async reconcile(): Promise<void> {
		if (!this.running.size) return void this.start();
		if (this.starting || this.moving.size) return;
		let session: SyncSession | null;
		try {
			session = await this.signedIn(() => this.session());
		} catch {
			return; // Offline: the engines keep retrying on their own.
		}
		if (!session) return;
		for (const [key, running] of this.running) {
			const now = session.brians.find((b) => keyOf(b) === key);
			const moved = now?.id && now.mount !== this.settings.roots[now.id];
			if (now && now.role === running.brian.role && !moved) continue;
			await running.engine.stop();
			this.running.delete(key);
		}
		await this.prepareFolders(session);
		for (const brian of session.brians) if (!this.running.has(keyOf(brian))) await this.run(brian);
		this.render();
	}

	/**
	 * Gets every shared brian's folder ready before its engine starts: trashes the folders of
	 * brians left, follows a folder renamed on another device, finds one renamed while Obsidian
	 * was closed (by the id in its BRIAN.md), and starts afresh where a folder is gone.
	 */
	private async prepareFolders(session: SyncSession): Promise<void> {
		const shared = session.brians.filter((b) => b.id);
		for (const id of Object.keys(this.settings.roots)) {
			if (!shared.some((b) => b.id === id)) await this.leave(id);
		}
		for (const brian of shared) {
			const id = brian.id!;
			if (this.running.has(id)) continue; // Running: its folder is settled.
			const server = brian.mount!;
			let local = this.settings.roots[id] ?? server;
			const exists = () => this.app.vault.getAbstractFileByPath(`brian/${local}`) instanceof TFolder;
			if (!exists()) {
				const found = await this.findFolder(id, shared, session.username);
				if (found) {
					local = found;
				} else {
					// Nothing on disk: a fresh download, never "everything was deleted".
					await IdbStore.destroy(this.storeName(id));
					local = server;
				}
			}
			if (local !== server && exists()) local = (await this.moveFolder(`brian/${local}`, `brian/${server}`)) ? server : local;
			this.settings.roots[id] = local;
		}
		await this.saveSettings();
		this.mountList = shared.map((b) => `brian/${this.settings.roots[b.id!] ?? b.mount}/`);
	}

	/** A folder under brian/ that isn't another brian's and whose BRIAN.md names this brian. */
	private async findFolder(id: string, shared: SyncBrian[], username: string): Promise<string | null> {
		const parent = this.app.vault.getAbstractFileByPath('brian');
		if (!(parent instanceof TFolder)) return null;
		const others = new Set(shared.filter((b) => b.id !== id).map((b) => foldPath(this.settings.roots[b.id!] ?? b.mount!)));
		others.add(foldPath(username));
		for (const child of parent.children) {
			if (!(child instanceof TFolder) || others.has(foldPath(child.name))) continue;
			const file = this.app.vault.getAbstractFileByPath(`${child.path}/BRIAN.md`);
			if (file instanceof TFile && (await this.app.vault.read(file)).includes(id)) return child.name;
		}
		return null;
	}

	/** Renames a folder if nothing is in the way. */
	private async moveFolder(from: string, to: string): Promise<boolean> {
		const folder = this.app.vault.getAbstractFileByPath(from);
		const target = this.app.vault.getAbstractFileByPath(to);
		if (!(folder instanceof TFolder) || (target && foldPath(to) !== foldPath(from))) return false;
		try {
			const parent = to.split('/').slice(0, -1).join('/');
			if (parent && !this.app.vault.getAbstractFileByPath(parent)) await this.app.vault.createFolder(parent);
			await this.app.vault.rename(folder, to);
			return true;
		} catch {
			return false;
		}
	}

	/** No longer a member: stop, forget, and move the folder to the trash (recoverable there). */
	private async leave(id: string): Promise<void> {
		const running = this.running.get(id);
		if (running) {
			await running.engine.stop();
			this.running.delete(id);
		}
		const mount = this.settings.roots[id];
		delete this.settings.roots[id];
		await this.saveSettings();
		await IdbStore.destroy(this.storeName(id));
		if (!mount) return;
		const root = `brian/${mount}/`;
		this.leaving.add(root);
		const folder = this.app.vault.getAbstractFileByPath(folderOf(root));
		if (folder) {
			await this.app.fileManager.trashFile(folder);
			new Notice(`Brian: you're no longer in ${running?.brian.name ?? mount}, so its folder was moved to the trash.`, 15_000);
		}
	}

	private async stopAll(): Promise<void> {
		for (const running of this.running.values()) await running.engine.stop();
		this.running.clear();
	}

	private mounts(): string[] {
		return [...this.mountList, ...this.leaving];
	}

	private storeName(key: string): string {
		return `brian-sync/${this.settings.installId}/${key}`;
	}

	// ---- A shared brian's own folder renamed or deleted ----

	/**
	 * If this rename moved a shared brian's folder (itself, a parent such as brian/, or seen
	 * through one of its files), follows it and returns true. Works whichever order Obsidian
	 * reports the folder and its contents in.
	 */
	private rootMoved(file: TAbstractFile, oldPath: string): boolean {
		let handled = false;
		for (const running of this.running.values()) {
			if (!running.brian.id) continue;
			const root = running.files.root;
			let moved: string | null = null;
			if (file instanceof TFolder && root.startsWith(`${oldPath}/`)) {
				moved = `${file.path}/${root.slice(oldPath.length + 1)}`;
			} else if (oldPath.startsWith(root) && !(this.app.vault.getAbstractFileByPath(folderOf(root)) instanceof TFolder)) {
				const inside = oldPath.slice(root.length);
				if (file.path.endsWith(`/${inside}`)) moved = file.path.slice(0, file.path.length - inside.length);
			}
			if (!moved || moved === root) continue;
			handled = true;
			void this.followRoot(running, root, moved);
		}
		return handled;
	}

	/** Settles a shared brian's folder rename with Brian, or puts the folder back. */
	private async followRoot(running: Running, from: string, to: string): Promise<void> {
		const id = running.brian.id!;
		running.files.root = to;
		this.mountList = this.mountList.map((m) => (m === from ? to : m));
		const agreed = this.settings.roots[id];
		const name = /^brian\/([^/]+)\/$/.exec(to)?.[1];
		if (name === agreed) return; // Back where Brian has it (e.g. our own undo).
		this.moving.add(id);
		try {
			let refusal = "Shared brians' folders live directly in brian/.";
			if (name) {
				const response = await this.signedIn(() => this.post('/mcp/sync/mount', { brian: id, mount: name })).catch(() => null);
				if (response?.status === 200) {
					const mount = String(response.json?.mount);
					this.settings.roots[id] = mount;
					await this.saveSettings();
					if (mount !== name) await this.moveFolder(folderOf(to), `brian/${mount}`);
					if (running.brian.role === 'owner') running.brian = { ...running.brian, name: mount }; // The brian took the new name.
					new Notice(`Brian: ${running.brian.name} is now in brian/${mount}/. Your agents find it there too.`);
					return;
				}
				refusal = String(response?.json?.error ?? "Brian couldn't be reached to rename it.");
			}
			new Notice(`Brian: ${running.brian.name}'s folder was put back. ${refusal}`, 15_000);
			await this.moveFolder(folderOf(to), `brian/${agreed}`);
		} finally {
			this.moving.delete(id);
		}
	}

	/**
	 * A shared brian's folder was deleted on this device. That doesn't delete it for everyone:
	 * it's downloaded again. Leaving a brian is done on the website.
	 */
	private async rootDeleted(running: Running): Promise<void> {
		const id = running.brian.id!;
		await running.engine.stop();
		if (this.running.get(id) === running) this.running.delete(id);
		await IdbStore.destroy(this.storeName(id));
		new Notice(
			`Brian: deleting ${running.brian.name}'s folder only removes it here, so it's downloaded again. To leave ${running.brian.name}, use the website.`,
			15_000
		);
		const session = await this.signedIn(() => this.session(id)).catch(() => null);
		const brian = session?.brians[0];
		if (brian && !this.running.has(id)) await this.run(brian);
		else void this.reconcile();
		this.render();
	}

	// ---- Vault events, routed to the brian that owns the path ----

	private owner(path: string): { running: Running; path: string } | null {
		for (const running of this.running.values()) {
			const inside = running.files.owns(path);
			if (inside !== null) return { running, path: inside };
		}
		return null;
	}

	private ownerOfFolder(path: string): { running: Running; path: string } | null {
		const shared = [...this.running.values()].filter((r) => r.brian.id);
		const personal = [...this.running.values()].filter((r) => !r.brian.id);
		for (const running of [...shared, ...personal]) {
			const inside = running.files.ownsFolder(path);
			if (inside !== null) return { running, path: inside };
		}
		return null;
	}

	private changed(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const owner = this.owner(file.path);
		if (owner) void owner.running.engine.fileChanged(owner.path).then(() => owner.running.engine.fileIdle());
	}

	private deleted(file: TAbstractFile): void {
		if (file instanceof TFolder) {
			for (const running of [...this.running.values()]) {
				if (running.brian.id && foldPath(running.files.root).startsWith(foldPath(`${file.path}/`))) void this.rootDeleted(running);
			}
		}
		const owner = file instanceof TFolder ? this.ownerOfFolder(file.path) : this.owner(file.path);
		if (!owner) return;
		const { running, path } = owner;
		const apply = () => (file instanceof TFolder ? running.engine.folderDeleted(path) : running.engine.fileDeleted(path));
		if (!running.brian.id) return void apply();
		// In a shared brian, wait a moment: if its whole folder went, nothing is deleted for everyone.
		const root = running.files.root;
		window.setTimeout(() => {
			if (this.running.get(running.brian.id!) !== running || running.files.root !== root) return;
			if (this.app.vault.getAbstractFileByPath(folderOf(root)) instanceof TFolder) void apply();
		}, DELETE_WAIT_MS);
	}

	private renamed(file: TAbstractFile, oldPath: string): void {
		if (this.rootMoved(file, oldPath)) return;
		if (file instanceof TFolder) {
			const from = this.ownerOfFolder(oldPath);
			const to = this.ownerOfFolder(file.path);
			if (from && to && from.running === to.running) return void from.running.engine.folderRenamed(from.path, to.path);
			// Between brians: a delete in one and new pages in the other.
			if (from) void from.running.engine.folderDeleted(from.path);
			if (to) for (const child of this.app.vault.getMarkdownFiles()) if (child.path.startsWith(`${file.path}/`)) this.changed(child);
			return;
		}
		if (!(file instanceof TFile)) return;
		const from = this.owner(oldPath);
		const to = this.owner(file.path);
		if (from && to && from.running === to.running) return void from.running.engine.fileRenamed(from.path, to.path);
		if (from) void from.running.engine.fileDeleted(from.path);
		if (to) void to.running.engine.fileChanged(to.path);
	}

	// ---- Pages Brian refused ----

	/** Shows a notice once for each newly refused page, with a fix when it's the name. */
	private tellRefusals(running: Running): void {
		for (const { path, message } of running.status.problems) {
			const key = `${keyOf(running.brian)}\n${path}\n${message}`;
			if (this.told.has(key)) continue;
			this.told.add(key);
			const vaultPath = running.files.root + path;
			const fix = this.betterName(vaultPath);
			const fragment = document.createDocumentFragment();
			fragment.createDiv({ text: `Brian can't sync "${vaultPath}". ${message}` });
			if (fix) {
				const button = fragment.createEl('button', { text: `Rename it to "${fix.split('/').pop()}"` });
				button.style.marginTop = '8px';
				button.onclick = () => void this.renameFor(vaultPath, fix);
			}
			new Notice(fragment, fix ? 0 : 15_000);
		}
	}

	/** A free name Brian accepts for a note whose name it refused, or null if the name isn't the problem. */
	betterName(vaultPath: string): string | null {
		const repaired = repairPath(vaultPath);
		if (!repaired || repaired === vaultPath || !/\.md$/i.test(repaired)) return null;
		for (let n = 1; n < 100; n++) {
			const candidate = n === 1 ? repaired : numbered(repaired, n);
			if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
		}
		return null;
	}

	/** Renames a note like the user would, so links to it are updated. */
	async renameFor(from: string, to: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(from);
		if (!(file instanceof TFile)) return void new Notice('Brian: that note has already been moved or renamed.');
		await this.app.fileManager.renameFile(file, to);
		new Notice(`Brian: renamed to "${to}".`);
	}

	// ---- Showing what's going on ----

	/** One line for the status bar. */
	summary(): string {
		if (this.problem) return 'Brian: not syncing';
		const states = [...this.running.values()].map((r) => r.status.state);
		const problems = [...this.running.values()].reduce((n, r) => n + r.status.problems.length, 0);
		const state = !states.length
			? 'starting'
			: states.includes('offline')
				? 'offline, retrying'
				: states.some((s) => s !== 'synced')
					? 'syncing'
					: 'synced';
		return `Brian: ${state}${problems ? ` (${problems} not syncing)` : ''}`;
	}

	problems(): { path: string; message: string }[] {
		return [...this.running.values()].flatMap((r) => r.status.problems.map((p) => ({ ...p, path: r.files.root + p.path })));
	}

	render(): void {
		this.statusBar?.setText(this.summary());
	}

	private openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}
}

class BrianSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: BrianPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const plugin = this.plugin;
		containerEl.empty();
		containerEl.createEl('p', { text: plugin.problem ?? plugin.summary() });

		if (plugin.settings.tokens) {
			new Setting(containerEl)
				.setName(plugin.settings.account ? `Signed in as ${plugin.settings.account}` : 'Signed in')
				.setDesc('Signing out stops syncing on this device. Your notes stay where they are.')
				.addButton((button) =>
					button
						.setCta()
						.setButtonText('Sync now')
						.onClick(async () => {
							await plugin.syncNow();
							this.display();
						})
				)
				.addButton((button) =>
					button.setButtonText('Sign out').onClick(async () => {
						await plugin.signOut();
						this.display();
					})
				);
		} else {
			new Setting(containerEl)
				.setName('Sign in to Brian')
				.setDesc('Opens your browser. When you come back, this vault starts syncing with your Brian.')
				.addButton((button) => button.setCta().setButtonText('Sign in').onClick(() => void plugin.signIn()));
		}

		const problems = plugin.problems();
		if (problems.length) {
			containerEl.createEl('h3', { text: 'Not syncing' });
			for (const { path, message } of problems) {
				const setting = new Setting(containerEl).setName(path).setDesc(message);
				const fix = plugin.betterName(path);
				if (fix) {
					setting.addButton((button) =>
						button.setButtonText(`Rename to "${fix.split('/').pop()}"`).onClick(async () => {
							await plugin.renameFor(path, fix);
							window.setTimeout(() => this.display(), 1000);
						})
					);
				}
			}
		}

		containerEl.createEl('h3', { text: 'Good to know' });
		const notes = containerEl.createEl('ul');
		notes.createEl('li', { text: 'Brian syncs markdown notes only, not images or other attachments.' });
		notes.createEl('li', { text: 'Brian must be the only thing syncing this vault: turn off Obsidian Sync, iCloud, Git and Remotely Save.' });
		notes.createEl('li', {
			text: 'Everything Brian adds lives in the brian/ folder. Shared brians are folders inside it: you can rename them, and deleting one only removes it here.'
		});

		new Setting(containerEl)
			.setName('Server')
			.setDesc('Only change this for testing (e.g. https://dev.mybrian.dev). Changing it signs you out.')
			.addText((text) =>
				text.setValue(plugin.settings.server).onChange(async (value) => {
					const server = value.trim().replace(/\/+$/, '');
					if (!/^https?:\/\/[^/]+$/.test(server) || server === plugin.settings.server) return;
					await plugin.signOut();
					plugin.settings.server = server;
					plugin.settings.clientId = null;
					plugin.settings.account = null;
					await plugin.saveSettings();
				})
			);
	}
}
