import type { LocalFiles } from '@brian/sync';
import { foldPath } from '@brian/sync';
import { normalizePath, TFile, TFolder, type App } from 'obsidian';

/** How long after the last keystroke a file still counts as being typed in (Obsidian saves after ~2 s). */
const TYPING_MS = 2500;

/**
 * One brian's markdown files in the vault. The personal brian's root is the vault root, minus the
 * folders where shared brians are mounted; a shared brian's root is brian/<mount>/. Files and
 * folders starting with a dot (.obsidian, .trash) are never synced.
 */
export class VaultFiles implements LocalFiles {
	constructor(
		private app: App,
		/** "" or "brian/<mount>/". */
		readonly root: string,
		/** Folders inside the root that belong to other brians ("brian/acme/"). */
		private excluded: () => string[],
		/** Vault path → time of the last keystroke in it. */
		private typing: Map<string, number>
	) {}

	/** The path inside this brian of a vault path, or null if the file isn't this brian's to sync. */
	owns(vaultPath: string): string | null {
		const fold = foldPath(vaultPath);
		if (!fold.startsWith(foldPath(this.root))) return null;
		if (this.excluded().some((prefix) => fold.startsWith(foldPath(prefix)))) return null;
		const path = vaultPath.slice(this.root.length);
		if (!path || !/\.md$/i.test(path)) return null;
		if (path.split('/').some((segment) => segment.startsWith('.'))) return null;
		return path;
	}

	/** Like `owns`, for folders: the folder's path inside this brian, or null. */
	ownsFolder(vaultPath: string): string | null {
		const fold = foldPath(`${vaultPath}/`);
		if (!fold.startsWith(foldPath(this.root)) || fold === foldPath(this.root)) return null;
		if (this.excluded().some((prefix) => fold.startsWith(foldPath(prefix)) || foldPath(prefix).startsWith(fold))) return null;
		const path = vaultPath.slice(this.root.length);
		return path.split('/').some((segment) => segment.startsWith('.')) ? null : path;
	}

	async list(): Promise<string[]> {
		return this.app.vault
			.getMarkdownFiles()
			.map((file) => this.owns(file.path))
			.filter((path): path is string => path !== null);
	}

	async read(path: string): Promise<string | null> {
		const file = this.file(path);
		return file ? this.app.vault.read(file) : null;
	}

	async write(path: string, text: string): Promise<void> {
		const file = this.file(path);
		if (file) {
			await this.app.vault.modify(file, text);
		} else {
			await this.folders(this.full(path));
			await this.app.vault.create(this.full(path), text);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.file(from);
		if (!file) return;
		await this.folders(this.full(to));
		// vault.rename, not fileManager.renameFile: that would rewrite links in other notes on every
		// device, and the same rewrite arriving from several devices would duplicate it.
		await this.app.vault.rename(file, this.full(to));
	}

	async remove(path: string): Promise<void> {
		const file = this.file(path);
		// Into the vault's own .trash: when unsure, keep.
		if (file) await this.app.vault.trash(file, false);
	}

	busy(path: string): boolean {
		const last = this.typing.get(this.full(path));
		return last !== undefined && Date.now() - last < TYPING_MS;
	}

	private full(path: string): string {
		return normalizePath(this.root + path);
	}

	private file(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(this.full(path));
		return file instanceof TFile ? file : null;
	}

	/** Creates the folders a file at `vaultPath` needs. */
	private async folders(vaultPath: string): Promise<void> {
		const parts = vaultPath.split('/').slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const folder = parts.slice(0, i).join('/');
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`"${folder}" is a file, so it can't hold a page.`);
			await this.app.vault.createFolder(folder);
		}
	}
}
