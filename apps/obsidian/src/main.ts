import { LIMITS } from '@brian/shared/limits';
import { BrianSync, type Connect, type SyncBrian, type SyncSession, type SyncStatus } from '@brian/sync';
import { App, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
import { finishSignIn, refresh, register, startSignIn, type PendingSignIn, type Tokens } from './auth';
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
}

const DEFAULTS: Settings = { server: 'https://mybrian.dev', clientId: null, tokens: null, pending: null, installId: '', installed: false };

/** How often to look for brians joined or left elsewhere (the website, another device). */
const RECONCILE_MS = 5 * 60 * 1000;

interface Running {
	brian: SyncBrian;
	files: VaultFiles;
	engine: BrianSync;
	status: SyncStatus;
}

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
	/** Folders of the shared brians this user is in ("brian/acme/"), known before any brian starts. */
	private mountList: string[] = [];

	async onload(): Promise<void> {
		this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
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

	async signOut(): Promise<void> {
		const names = [...this.running.keys()].map((key) => this.storeName(key));
		await this.stopAll();
		for (const name of names) await IdbStore.destroy(name);
		this.settings.tokens = null;
		this.settings.installed = false;
		await this.saveSettings();
		this.problem = null;
		this.render();
	}

	/** A valid access token, refreshed when it's about to expire. */
	private async accessToken(): Promise<string> {
		const tokens = this.settings.tokens;
		if (!tokens || !this.settings.clientId) throw new Error('Not signed in.');
		if (tokens.expiresAt - Date.now() > 60_000) return tokens.access;
		this.settings.tokens = await refresh(this.settings.server, this.settings.clientId, tokens);
		await this.saveSettings();
		return this.settings.tokens.access;
	}

	/** Tickets from Brian: for every brian, or just one ("personal" or a shared brian's id). */
	private async session(only?: string): Promise<SyncSession> {
		const url = `${this.settings.server}/mcp/sync${only ? `?brian=${encodeURIComponent(only)}` : ''}`;
		const response = await requestUrl({ url, method: 'POST', headers: { Authorization: `Bearer ${await this.accessToken()}` }, throw: false });
		if (response.status === 401 && this.settings.tokens) {
			this.settings.tokens.expiresAt = 0; // Refresh once, then give up.
			const retry = await requestUrl({ url, method: 'POST', headers: { Authorization: `Bearer ${await this.accessToken()}` }, throw: false });
			if (retry.status === 200) return retry.json as SyncSession;
		}
		if (response.status !== 200) throw new Error(response.json?.error ?? `Brian answered ${response.status}.`);
		return response.json as SyncSession;
	}

	// ---- Running the sync ----

	async restart(): Promise<void> {
		await this.stopAll();
		await this.start();
	}

	private async start(): Promise<void> {
		if (this.starting || this.running.size) return;
		this.starting = true;
		try {
			this.problem = this.settings.tokens ? otherSyncTool(this.app) : 'Sign in to start syncing.';
			if (!this.problem && !this.settings.installed) this.problem = cannotInstall(this.app, LIMITS.pagesPerBrian);
			if (this.problem) {
				// Say why out loud: a sync that silently doesn't run looks like a broken one.
				if (this.settings.tokens) new Notice(`Brian isn't syncing. ${this.problem}`, 15_000);
				return;
			}
			let session: SyncSession;
			try {
				session = await this.session();
			} catch (error) {
				this.problem = `Can't reach Brian: ${(error as Error).message} Retrying in a few minutes.`;
				return;
			}
			if (!this.settings.installed) {
				this.settings.installed = true;
				await this.saveSettings();
			}
			// Before anything starts, so the personal brian never takes a shared brian's files as its own.
			this.mountList = this.mountsOf(session);
			for (const brian of session.brians) await this.run(brian);
		} finally {
			this.starting = false;
			this.render();
		}
	}

	private async run(brian: SyncBrian): Promise<void> {
		const key = brian.id ?? 'personal';
		const root = brian.id ? `brian/${brian.mount}/` : '';
		const files = new VaultFiles(this.app, root, () => (brian.id ? [] : this.mounts()), this.typing);
		const running: Running = { brian, files, engine: null as unknown as BrianSync, status: { state: 'connecting', problems: [] } };
		running.engine = new BrianSync({
			files,
			store: new IdbStore(this.storeName(key)),
			connect: this.connector(key, brian),
			readOnly: brian.role === 'viewer',
			onStatus: (status) => {
				running.status = status;
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
			const ticket = first ?? (await this.session(key)).brians[0]?.ticket;
			first = null;
			if (!ticket) {
				void this.reconcile(); // No longer a member: stop syncing this brian.
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

	/** Starts brians joined elsewhere and stops ones left; their files stay (when unsure, keep). */
	private async reconcile(): Promise<void> {
		if (!this.running.size) return void this.start();
		let session: SyncSession;
		try {
			session = await this.session();
		} catch {
			return;
		}
		this.mountList = this.mountsOf(session);
		const keys = new Set(session.brians.map((b) => b.id ?? 'personal'));
		for (const [key, running] of this.running) {
			const now = session.brians.find((b) => (b.id ?? 'personal') === key);
			if (keys.has(key) && now?.role === running.brian.role && now.mount === running.brian.mount) continue;
			await running.engine.stop();
			this.running.delete(key);
		}
		for (const brian of session.brians) if (!this.running.has(brian.id ?? 'personal')) await this.run(brian);
		this.render();
	}

	private async stopAll(): Promise<void> {
		for (const running of this.running.values()) await running.engine.stop();
		this.running.clear();
	}

	private mounts(): string[] {
		return this.mountList;
	}

	private mountsOf(session: SyncSession): string[] {
		return session.brians.filter((b) => b.id).map((b) => `brian/${b.mount}/`);
	}

	private storeName(key: string): string {
		return `brian-sync/${this.settings.installId}/${key}`;
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
			const owner = this.ownerOfFolder(file.path);
			if (owner) void owner.running.engine.folderDeleted(owner.path);
			return;
		}
		const owner = this.owner(file.path);
		if (owner) void owner.running.engine.fileDeleted(owner.path);
	}

	private renamed(file: TAbstractFile, oldPath: string): void {
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

	// ---- Showing what's going on ----

	/** One line for the status bar. */
	summary(): string {
		if (this.problem) return 'Brian: not syncing';
		const states = [...this.running.values()].map((r) => r.status.state);
		const problems = [...this.running.values()].reduce((n, r) => n + r.status.problems.length, 0);
		const state = !states.length
			? 'starting'
			: states.includes('offline')
				? 'offline'
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
				.setName('Signed in')
				.setDesc('Signing out stops syncing on this device. Your notes stay where they are.')
				.addButton((button) => button.setButtonText('Sign out').onClick(async () => {
					await plugin.signOut();
					this.display();
				}))
				.addButton((button) => button.setButtonText('Reconnect').onClick(async () => {
					await plugin.restart();
					this.display();
				}));
		} else {
			new Setting(containerEl)
				.setName('Sign in to Brian')
				.setDesc('Opens your browser. When you come back, this vault starts syncing with your Brian.')
				.addButton((button) => button.setCta().setButtonText('Sign in').onClick(() => void plugin.signIn()));
		}

		const problems = plugin.problems();
		if (problems.length) {
			containerEl.createEl('h3', { text: 'Not syncing' });
			const list = containerEl.createEl('ul');
			for (const { path, message } of problems) list.createEl('li', { text: `${path}: ${message}` });
		}

		containerEl.createEl('h3', { text: 'Good to know' });
		const notes = containerEl.createEl('ul');
		notes.createEl('li', { text: 'Brian syncs markdown notes only, not images or other attachments.' });
		notes.createEl('li', { text: 'Brian must be the only thing syncing this vault: turn off Obsidian Sync, iCloud, Git and Remotely Save.' });
		notes.createEl('li', { text: 'Everything Brian adds lives in the brian/ folder. Shared brians appear as folders inside it.' });

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
					await plugin.saveSettings();
				})
			);
	}
}
