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

/** The MCP server's instructions: how this user's Brian is laid out, and the rules for agents. */
export function instructions(brian: Brian): string {
	const me = brian.username ?? 'the user';
	const shared = brian.brians.length
		? brian.brians
				.map((b) => `  - brian/${b.mount}/ — "${b.name}", ${b.role}${b.role === 'viewer' ? ' (read-only)' : ''}, ${b.visibility}`)
				.join('\n')
		: '  (none yet)';
	return `This is ${me}'s Brian: their knowledge, as markdown pages (paths like notes/today.md).

Layout:
- Everything outside brian/ is ${me}'s own notes, written mainly by them. Edit pages there only when ${me} asks you to or is working on that page with you. Don't add AI-written pages there.
- brian/${me}/ is yours to write in freely: put pages you write on your own here (summaries, session logs, research, context for later).
- brian/BRIAN.md, if it exists, holds ${me}'s instructions for you. Read it before doing anything else.
- Every other folder brian/<name>/ is a brian shared with other people. Editors' changes reach every member. Read its BRIAN.md before working in it. Shared brians:
${shared}

Rules:
- Don't copy ${me}'s own notes into a shared brian unless asked: other members can read everything there.
- Don't add links between brians (e.g. from brian/<name>/ to a page outside it). Other members can't follow them. Leave links that people wrote alone.
- search only finds pages: read whole pages with read_page before acting on them. To overwrite a page, pass the etag from read_page.`;
}
