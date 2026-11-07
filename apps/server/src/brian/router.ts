import type { BrianSummary } from '@brian/shared';
import { normalizePath, normalizePrefix, VaultError } from '../vault/paths';
import type { Listing, Page, SearchHit, Vault } from '../vault/vault';
import { membershipsOf, type Bindings } from './members';

/** Where a path lives: which brian's vault, under what path there. */
interface Target {
	vault: DurableObjectStub<Vault>;
	/** The path inside that vault. */
	inner: string;
	/** What to put in front of inner paths to show them to the user ("" or "brian/<mount>/"). */
	outer: string;
	/** The shared brian, or null for the user's personal brian. */
	brian: BrianSummary | null;
}

/**
 * One user's whole Brian, as MCP tools see it: their personal brian, with every shared brian
 * they're a member of mounted at brian/<mount>/.
 *
 * Paths under brian/<mount>/ go to that brian's vault, with the prefix removed. Every other
 * path, brian/<username>/ included, goes to the personal vault unchanged.
 */
export class Brian {
	private constructor(
		private env: Bindings,
		private userId: string,
		readonly username: string | null,
		readonly brians: BrianSummary[]
	) {}

	static async load(env: Bindings, userId: string): Promise<Brian> {
		const [username, brians] = await Promise.all([
			env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first<string>('username'),
			membershipsOf(env.DB, userId)
		]);
		return new Brian(env, userId, username, brians);
	}

	async list(prefix = ''): Promise<Listing> {
		const base = normalizePrefix(prefix);
		this.ready();
		const mounted = /^brian\/([^/]+)\//.exec(base);
		const brian = mounted && this.mount(mounted[1]);
		if (brian) {
			const target = this.targetOf(brian, base.slice(mounted[0].length));
			const { folders, files } = await target.vault.list(target.inner);
			return { folders: folders.map((f) => target.outer + f), files: files.map((f) => target.outer + f) };
		}
		const own = await this.personal().list(base);
		// Shared brians show up as folders in brian/, and brian/ itself in the root.
		const extra = base === 'brian/' ? this.brians.map((b) => `brian/${b.mount}/`) : base === '' && this.brians.length ? ['brian/'] : [];
		const folders = [...new Set([...own.folders, ...extra])].sort();
		return { folders, files: own.files };
	}

	/** Searches every brian at once and merges the hits by score. */
	async search(query: string, limit = 20): Promise<SearchHit[]> {
		this.ready();
		const targets = [{ vault: this.personal(), outer: '' }, ...this.brians.map((b) => this.targetOf(b, ''))];
		const results = await Promise.all(
			targets.map(async ({ vault, outer }) => (await vault.search(query, limit)).map((hit) => ({ ...hit, path: outer + hit.path })))
		);
		return results
			.flat()
			.sort((a, b) => a.score - b.score)
			.slice(0, limit);
	}

	async read(path: string): Promise<Page> {
		const target = this.route(path);
		return this.shown(target, await target.vault.read(target.inner));
	}

	async write(path: string, content: string, expectedEtag?: string): Promise<Page> {
		const target = this.writable(this.route(path));
		return this.shown(target, await target.vault.write(target.inner, content, expectedEtag));
	}

	async edit(path: string, oldString: string, newString: string, replaceAll = false): Promise<Page> {
		const target = this.writable(this.route(path));
		return this.shown(target, await target.vault.edit(target.inner, oldString, newString, replaceAll));
	}

	async delete(path: string): Promise<void> {
		const target = this.writable(this.route(path));
		await target.vault.delete(target.inner);
	}

	/** Within one brian this is atomic. Between brians it's a copy and a delete. */
	async move(from: string, to: string): Promise<Page> {
		const source = this.writable(this.route(from));
		const target = this.writable(this.route(to));
		if (source.brian?.id === target.brian?.id) {
			return this.shown(target, await target.vault.move(source.inner, target.inner));
		}
		const page = await source.vault.read(source.inner);
		const moved = await target.vault.write(target.inner, page.content);
		try {
			await source.vault.delete(source.inner);
		} catch (error) {
			const shownFrom = source.outer + source.inner;
			throw new VaultError(`Copied to ${target.outer + target.inner}, but couldn't remove ${shownFrom}: ${(error as Error).message}`);
		}
		return this.shown(target, moved);
	}

	private route(path: string): Target {
		const key = normalizePath(path);
		this.ready();
		const mounted = /^brian\/([^/]+)\/(.+)$/.exec(key);
		const brian = mounted && this.mount(mounted[1]);
		if (brian) return this.targetOf(brian, mounted[2]);
		return { vault: this.personal(), inner: key, outer: '', brian: null };
	}

	private targetOf(brian: BrianSummary, inner: string): Target {
		return { vault: this.env.VAULT.getByName(brian.id), inner, outer: `brian/${brian.mount}/`, brian };
	}

	private mount(name: string): BrianSummary | undefined {
		return this.brians.find((b) => b.mount === name);
	}

	private personal() {
		return this.env.VAULT.getByName(this.userId);
	}

	/** Viewers read a brian but never change it: their changes would reach no one. */
	private writable(target: Target): Target {
		if (target.brian?.role === 'viewer') {
			throw new VaultError(
				`brian/${target.brian.mount}/ is read-only: you're a viewer of "${target.brian.name}". ` +
					`To keep your own version of a page, write it under brian/${this.username}/ instead.`
			);
		}
		return target;
	}

	private ready(): void {
		if (!this.username) throw new VaultError(`Finish setting up first: pick a username at ${this.env.BASE_URL}/welcome.`);
	}

	private shown(target: Target, page: Page): Page {
		return { ...page, path: target.outer + page.path };
	}
}

/**
 * The MCP server's instructions: only what always holds, plus this user's shared brians.
 * Everything that changes with the user lives in the BRIAN.md files, which agents keep current.
 * Roles are described here, not enforced here: the router refuses what a role can't do.
 */
export function instructions(brian: Brian): string {
	const me = brian.username ?? 'the user';
	const shared = brian.brians.length
		? brian.brians.map((b) => `- brian/${b.mount}/ — "${b.name}" (${b.visibility}). You are ${b.role === 'owner' ? 'the owner' : `a ${b.role}`}.`).join('\n')
		: '- (none yet)';
	return `This is ${me}'s Brian: their knowledge, as markdown pages.

Start by reading brian/BRIAN.md: it says how ${me} wants you to work, and you keep it up to date. Each shared brian has its own BRIAN.md, a guide to what's in it, which you also keep current.

Always:
- Outside brian/ are ${me}'s own notes. Edit them only when ${me} asks you to, or is working on that page with you.
- brian/${me}/ is yours: write the pages you create on your own there.
- Don't add links between brians.
- search only finds pages: read whole pages with read_page before acting on them. To overwrite a page, pass the etag from read_page.

Shared brians (editors' changes reach every member; viewers can read but not change them):
${shared}`;
}
