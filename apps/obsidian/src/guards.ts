import { FileSystemAdapter, type App } from 'obsidian';

/** Obsidian internals the guards peek at. Not public API, so every access is defensive. */
interface Internals {
	internalPlugins?: { getEnabledPluginById?(id: string): unknown; plugins?: Record<string, { enabled?: boolean }> };
	plugins?: { enabledPlugins?: Set<string> };
}

/** Community plugins that sync the vault themselves. */
const SYNC_PLUGINS: Record<string, string> = {
	'obsidian-git': 'Obsidian Git',
	'remotely-save': 'Remotely Save'
};

/**
 * Why Brian can't run in this vault right now, or null. Brian must be the only thing syncing the
 * vault: with two, an edit arrives by two routes and can be applied twice.
 */
export function otherSyncTool(app: App): string | null {
	const internals = app as unknown as Internals;
	const core = internals.internalPlugins;
	if (core?.getEnabledPluginById?.('sync') || core?.plugins?.sync?.enabled) {
		return 'Obsidian Sync is on. Brian has to be the only thing syncing this vault: turn Obsidian Sync off (Settings → Core plugins → Sync).';
	}
	for (const [id, name] of Object.entries(SYNC_PLUGINS)) {
		if (internals.plugins?.enabledPlugins?.has(id)) {
			return `${name} is on. Brian has to be the only thing syncing this vault: turn ${name} off (Settings → Community plugins).`;
		}
	}
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter && /Mobile Documents\/iCloud~md~obsidian/.test(adapter.getBasePath())) {
		return "This vault is in iCloud. Brian has to be the only thing syncing it: move the vault out of iCloud Drive's Obsidian folder.";
	}
	return null;
}

/** Why Brian can't be installed into this vault, or null. Only checked before the first sync. */
export function cannotInstall(app: App, maxPages: number): string | null {
	if (app.vault.getAbstractFileByPath('brian')) {
		return 'This vault already has a folder called "brian". Brian keeps everything it creates there, so rename or move that folder first.';
	}
	const pages = app.vault.getMarkdownFiles().filter((file) => !file.path.split('/').some((s) => s.startsWith('.'))).length;
	if (pages > maxPages) {
		return `This vault has ${pages.toLocaleString('en-US')} notes; a brian holds up to ${maxPages.toLocaleString('en-US')}.`;
	}
	return null;
}
