import { LIMITS, normalizeName, type ActivityEntry, type ActivityFilter, type ActivityPage, type BrianAction, type Outcome, type Role } from '@brian/shared';
import type { ActivityGroup } from '../vault/vault';
import * as members from './members';

/**
 * The Activity page: who changed what, newest first, across the user's own brian and every shared
 * brian they're in. Page changes come from each brian's Durable Object (its history table); changes
 * to brians themselves (created, shared, deleted…) from D1 (the activity table).
 *
 * Members of a shared brian see all of its page changes and member changes. Invitations, which can
 * name an email address, are shown only to the owner, as on the brian's own page.
 */

type Bindings = members.Bindings;

const PAGE = 50;
/** Each source is asked for a few more than a page, so entries sharing the last instant all fit. */
const FETCH = PAGE + 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNDOABLE_PAGE = new Set(['create', 'move', 'delete']);
const UNDOABLE_BRIAN = new Set<BrianAction>(['brian.create', 'brian.visibility', 'brian.invite', 'brian.uninvite', 'brian.role', 'brian.remove', 'brian.restore']);
const OWNER_ONLY = new Set<string>(['brian.invite', 'brian.uninvite']);

/** A brian the user can see the history of: one they're in, or one they were in that's in the trash. */
interface Visible {
	id: string;
	name: string;
	role: Role;
	/** Its folder in this user's Brian, while it's live. */
	mount: string | null;
}

type PageKey = { k: 'p'; b: string | null; at: number; u: string; s: string; a: string };
type BrianKey = { k: 'b'; id: number };

interface Row {
	id: number;
	brian_id: string;
	user_id: string;
	source: string;
	action: BrianAction;
	target: string | null;
	role: string | null;
	from_value: string | null;
	at: number;
}

async function visibleBrians(env: Bindings, userId: string): Promise<{ live: Visible[]; trashed: Visible[] }> {
	const live = (await members.membershipsOf(env.DB, userId)).map((b) => ({ id: b.id, name: b.name, role: b.role, mount: b.mount }));
	const trashed = (
		await env.DB.prepare(
			`SELECT brians.id, brians.name, deleted_members.role FROM deleted_members JOIN brians ON brians.id = deleted_members.brian_id
			 WHERE deleted_members.user_id = ? AND brians.deleted_at > ?`
		)
			.bind(userId, Math.floor((Date.now() - LIMITS.trashDays * DAY_MS) / 1000))
			.all<{ id: string; name: string; role: Role }>()
	).results.map((b) => ({ ...b, mount: null }));
	return { live, trashed };
}

export async function activityOf(env: Bindings, userId: string, filter: ActivityFilter = {}): Promise<ActivityPage> {
	const before = Number.isFinite(filter.before) ? Number(filter.before) : Number.MAX_SAFE_INTEGER;
	const source = filter.app?.trim() || undefined;
	let user: string | undefined;
	if (filter.person?.trim()) {
		const found = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(normalizeName(filter.person)).first<string>('id');
		if (!found) return { entries: [], before: null };
		user = found;
	}

	const { live, trashed } = await visibleBrians(env, userId);
	const only = filter.brian?.trim() || undefined;
	const personal = !only || only === 'personal';
	const liveShown = live.filter((b) => !only || b.id === only);
	const allShown = [...liveShown, ...trashed.filter((b) => !only || b.id === only)];

	const pageQuery = { before, limit: FETCH, user, source };
	const [own, shared, rows] = await Promise.all([
		personal && (!user || user === userId) ? env.VAULT.getByName(userId).activity(pageQuery) : Promise.resolve([] as ActivityGroup[]),
		Promise.all(liveShown.map(async (b) => ({ brian: b, groups: await env.VAULT.getByName(b.id).activity(pageQuery) }))),
		allShown.length
			? env.DB.prepare(
					`SELECT id, brian_id, user_id, source, action, target, role, from_value, at FROM activity
					 WHERE brian_id IN (SELECT value FROM json_each(?1)) AND at < ?2
					 AND (?3 IS NULL OR user_id = ?3) AND (?4 IS NULL OR source = ?4)
					 AND (action NOT IN ('brian.invite', 'brian.uninvite') OR brian_id IN (SELECT value FROM json_each(?5)))
					 ORDER BY at DESC LIMIT ?6`
				)
					.bind(
						JSON.stringify(allShown.map((b) => b.id)),
						before,
						user ?? null,
						source ?? null,
						JSON.stringify(allShown.filter((b) => b.role === 'owner').map((b) => b.id)),
						FETCH
					)
					.all<Row>()
					.then((r) => r.results)
			: Promise.resolve([] as Row[])
	]);

	const userIds = new Set<string>([userId, ...own.map((g) => g.user), ...shared.flatMap((s) => s.groups.map((g) => g.user)), ...rows.map((r) => r.user_id)]);
	const names = new Map(
		(
			await env.DB.prepare('SELECT id, username FROM users WHERE id IN (SELECT value FROM json_each(?))')
				.bind(JSON.stringify([...userIds]))
				.all<{ id: string; username: string | null }>()
		).results.map((r) => [r.id, r.username])
	);
	const who = (id: string) => ({ who: names.get(id) ?? null, you: id === userId });
	const trashCutoff = Date.now() - LIMITS.trashDays * DAY_MS;

	const fromPages = (groups: ActivityGroup[], brian: Visible | null): ActivityEntry[] =>
		groups.map((g) => {
			const outer = brian ? `brian/${brian.mount}/` : '';
			const key: PageKey = { k: 'p', b: brian?.id ?? null, at: g.at, u: g.user, s: g.source, a: g.action };
			const canWrite = !brian || brian.role !== 'viewer';
			return {
				key: JSON.stringify(key),
				at: g.at,
				...who(g.user),
				app: g.source,
				action: g.action,
				brian: brian && { id: brian.id, name: brian.name },
				path: outer + g.path,
				fromPath: g.fromPath === null ? null : outer + g.fromPath,
				count: g.count,
				undoable: canWrite && UNDOABLE_PAGE.has(g.action) && (g.action !== 'delete' || g.at > trashCutoff)
			};
		});

	const byId = new Map(allShown.map((b) => [b.id, b]));
	const liveIds = new Set(live.map((b) => b.id));
	const fromRows: ActivityEntry[] = rows.map((r) => {
		const brian = byId.get(r.brian_id)!;
		const owner = brian.role === 'owner';
		const isLive = liveIds.has(r.brian_id);
		const undoable = owner && (r.action === 'brian.delete' ? !isLive : isLive && UNDOABLE_BRIAN.has(r.action));
		const key: BrianKey = { k: 'b', id: r.id };
		return {
			key: JSON.stringify(key),
			at: r.at,
			...who(r.user_id),
			app: r.source,
			action: r.action,
			brian: { id: brian.id, name: brian.name },
			target: r.target,
			role: r.role,
			from: r.from_value,
			undoable
		};
	});

	const all = [...fromPages(own, null), ...shared.flatMap((s) => fromPages(s.groups, s.brian)), ...fromRows].sort((a, b) => b.at - a.at);
	const full = own.length === FETCH || shared.some((s) => s.groups.length === FETCH) || rows.length === FETCH;
	if (all.length <= PAGE) return { entries: all, before: full && all.length ? all.at(-1)!.at : null };
	// Everything from the last instant shown goes on this page: the next one starts strictly before it.
	const last = all[PAGE - 1].at;
	const entries = all.filter((e, i) => i < PAGE || e.at === last);
	return { entries, before: last };
}

const isString = (v: unknown): v is string => typeof v === 'string';

function parseKey(key: string): PageKey | BrianKey | null {
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	if (v.k === 'b' && Number.isInteger(v.id)) return { k: 'b', id: v.id as number };
	if (v.k === 'p' && (v.b === null || isString(v.b)) && Number.isFinite(v.at) && isString(v.u) && isString(v.s) && isString(v.a)) {
		return { k: 'p', b: v.b as string | null, at: v.at as number, u: v.u, s: v.s, a: v.a };
	}
	return null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Undoes one Activity entry, as `userId` from the website. Page changes: anyone who can edit the
 * brian (its owner and editors; only the user in their own brian). Brian changes: the owner,
 * through the same functions (and checks) as everything else; undoing them is itself logged.
 */
export async function undo(env: Bindings, userId: string, key: string): Promise<Outcome<string>> {
	const ref = parseKey(key);
	if (!ref) return { ok: false, message: "That change can't be found." };
	const { live, trashed } = await visibleBrians(env, userId);

	if (ref.k === 'p') {
		const brian = ref.b === null ? null : live.find((b) => b.id === ref.b);
		if (brian === undefined) return { ok: false, message: "That change can't be found." };
		if (brian?.role === 'viewer') return { ok: false, message: `You're a viewer of "${brian.name}", so you can't change it.` };
		const vault = env.VAULT.getByName(brian?.id ?? userId);
		const result = await vault.undo(
			{ at: ref.at, user: ref.u, source: ref.s, action: ref.a as ActivityGroup['action'] },
			{ user: userId, source: members.WEBSITE }
		);
		if ('error' in result) return { ok: false, message: result.error };
		const { undone, skipped } = result;
		if (!undone) return { ok: false, message: 'Nothing left to undo: the pages have changed since, or it was undone already.' };
		const verb = ref.a === 'delete' ? 'Restored' : ref.a === 'create' ? 'Moved to the trash:' : 'Moved back:';
		const left = skipped ? ` ${plural(skipped, 'page')} had changed since and ${skipped === 1 ? 'was' : 'were'} left alone.` : '';
		return { ok: true, value: `${verb} ${plural(undone, 'page')}.${left}` };
	}

	const row = await env.DB.prepare('SELECT id, brian_id, user_id, source, action, target, role, from_value, at FROM activity WHERE id = ?')
		.bind(ref.id)
		.first<Row>();
	const brian = row && [...live, ...trashed].find((b) => b.id === row.brian_id);
	if (!row || !brian || (OWNER_ONLY.has(row.action) && brian.role !== 'owner')) return { ok: false, message: "That change can't be found." };
	const id = row.brian_id;
	const by = members.WEBSITE;
	const done = (outcome: Outcome<unknown>, message: string): Outcome<string> => (outcome.ok ? { ok: true, value: message } : outcome);
	switch (row.action) {
		case 'brian.create':
		case 'brian.restore':
			return done(await members.deleteBrian(env, userId, id, by), `Moved "${brian.name}" to the trash. You can restore it for ${LIMITS.trashDays} days.`);
		case 'brian.delete':
			return done(await members.restoreBrian(env, userId, id, by), `Restored "${brian.name}", with its members.`);
		case 'brian.visibility':
			if (row.from_value !== 'private' && row.from_value !== 'public') break;
			return done(await members.setVisibility(env.DB, userId, id, row.from_value, by), `"${brian.name}" is ${row.from_value} again.`);
		case 'brian.invite':
			if (!row.target) break;
			return done(await members.cancelInvite(env, userId, id, row.target, by), `Took back the invitation to ${row.target}.`);
		case 'brian.uninvite':
			if (!row.target || !row.role) break;
			return done(await members.invite(env, userId, id, row.target, row.role, by), `Invited ${row.target} again.`);
		case 'brian.role':
			if (!row.target || !row.from_value) break;
			return done(await members.setRole(env, userId, id, row.target, row.from_value, by), `${row.target} is ${row.from_value === 'editor' ? 'an editor' : 'a viewer'} again.`);
		case 'brian.remove':
			// Nobody is put in a brian without saying yes: they're invited back.
			if (!row.target || !row.from_value) break;
			return done(
				await members.invite(env, userId, id, row.target, row.from_value, by),
				`Invited ${row.target} back as ${row.from_value === 'editor' ? 'an editor' : 'a viewer'}. They're a member again once they accept.`
			);
	}
	return { ok: false, message: "This change can't be undone." };
}
