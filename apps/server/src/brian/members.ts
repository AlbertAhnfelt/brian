import {
	isValidName,
	LIMITS,
	NAME_RULES,
	normalizeName,
	personalBrianMd,
	sharedBrianMd,
	type BrianSummary,
	type BrianView,
	type Member,
	type Outcome,
	type Role,
	type Visibility
} from '@brian/shared';

/**
 * Shared brians and their members. Every function acts as `userId` and checks that user's role
 * before changing anything. Callers pass a user ID they have verified (an MCP token, or the
 * website's session over the service binding).
 */

/** The bindings this code needs: callers pass the Worker's env. */
export type Bindings = Pick<Env, 'DB' | 'VAULT' | 'BASE_URL'>;

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = (message: string): { ok: false; message: string } => ({ ok: false, message });
const done: Outcome = { ok: true, value: undefined };

const NOT_FOUND = 'No such brian.';

/** A user's memberships, with what their Brian needs to route paths. */
export async function membershipsOf(db: D1Database, userId: string): Promise<BrianSummary[]> {
	const rows = await db
		.prepare(
			`SELECT brians.id, brians.name, brians.visibility, members.role, members.mount
			 FROM members JOIN brians ON brians.id = members.brian_id
			 WHERE members.user_id = ? ORDER BY members.mount`
		)
		.bind(userId)
		.all<BrianSummary>();
	return rows.results;
}

async function membership(db: D1Database, userId: string, brianId: string): Promise<BrianSummary | null> {
	return db
		.prepare(
			`SELECT brians.id, brians.name, brians.visibility, members.role, members.mount
			 FROM members JOIN brians ON brians.id = members.brian_id
			 WHERE members.user_id = ? AND members.brian_id = ?`
		)
		.bind(userId, brianId)
		.first<BrianSummary>();
}

/** The caller's membership if they own the brian. A non-owner gets the same answer as a stranger. */
async function owned(db: D1Database, userId: string, brianId: string): Promise<BrianSummary | null> {
	const found = await membership(db, userId, brianId);
	return found?.role === 'owner' ? found : null;
}

async function userByUsername(db: D1Database, username: string): Promise<{ id: string; username: string } | null> {
	return db
		.prepare('SELECT id, username FROM users WHERE username = ?')
		.bind(normalizeName(username))
		.first<{ id: string; username: string }>();
}

async function usernameOf(db: D1Database, userId: string): Promise<string | null> {
	return db.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first<string>('username');
}

/**
 * A free folder name for a brian in this user's Brian: `name`, else `name-2`, `name-3`, …
 * It must not be the user's own agent folder, another mount, or a folder already holding the
 * user's own pages under brian/.
 */
async function pickMount(env: Bindings, userId: string, name: string): Promise<string | null> {
	const username = await usernameOf(env.DB, userId);
	if (!username) return null;
	const taken = new Set((await membershipsOf(env.DB, userId)).map((m) => m.mount));
	const personal = env.VAULT.getByName(userId);
	for (let n = 1; n <= LIMITS.folderNameAttempts; n++) {
		const suffix = n === 1 ? '' : `-${n}`;
		const candidate = name.slice(0, 32 - suffix.length).replace(/-+$/, '') + suffix;
		if (!isValidName(candidate) || candidate === username || taken.has(candidate)) continue;
		const { folders, files } = await personal.list(`brian/${candidate}/`);
		if (folders.length || files.length) continue;
		return candidate;
	}
	return null;
}

async function roomForAnother(db: D1Database, userId: string): Promise<boolean> {
	const count = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = ?').bind(userId).first<number>('n');
	return (count ?? 0) < LIMITS.sharedBriansPerUser;
}

/** Adds a membership with a free folder name. */
async function insertMember(env: Bindings, brian: { id: string; name: string }, userId: string, role: Role): Promise<Outcome<string>> {
	if (!(await roomForAnother(env.DB, userId))) return no(`A Brian can hold at most ${LIMITS.sharedBriansPerUser} shared brians.`);
	const mount = await pickMount(env, userId, brian.name);
	if (!mount) return no('No free folder name for this brian. Choose a username first, or free up brian/ folders.');
	try {
		await env.DB.prepare('INSERT INTO members (brian_id, user_id, role, mount) VALUES (?, ?, ?, ?)')
			.bind(brian.id, userId, role, mount)
			.run();
	} catch (error) {
		if (String(error).includes('UNIQUE')) return no('Already a member, or the folder name was just taken. Try again.');
		throw error;
	}
	return ok(mount);
}

export async function createBrian(env: Bindings, userId: string, input: string, visibility: Visibility): Promise<Outcome<BrianSummary>> {
	const name = normalizeName(input);
	if (!isValidName(name)) return no(`Brian names are ${NAME_RULES}`);
	if (visibility !== 'private' && visibility !== 'public') return no('Unknown visibility.');
	if (!(await usernameOf(env.DB, userId))) return no('Choose a username first.');
	const id = `b_${crypto.randomUUID()}`;
	await env.DB.prepare('INSERT INTO brians (id, name, visibility) VALUES (?, ?, ?)').bind(id, name, visibility).run();
	const joined = await insertMember(env, { id, name }, userId, 'owner');
	if (!joined.ok) {
		await env.DB.prepare('DELETE FROM brians WHERE id = ?').bind(id).run();
		return joined;
	}
	await env.VAULT.getByName(id).write('BRIAN.md', sharedBrianMd(id, name));
	return ok({ id, name, visibility, role: 'owner', mount: joined.value });
}

export async function viewBrian(db: D1Database, userId: string, brianId: string): Promise<BrianView | null> {
	const mine = await membership(db, userId, brianId);
	if (mine) {
		const members = await db
			.prepare(
				`SELECT users.username, members.role FROM members JOIN users ON users.id = members.user_id
				 WHERE members.brian_id = ? ORDER BY CASE members.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, users.username`
			)
			.bind(brianId)
			.all<Member>();
		return { member: true, brian: mine, members: members.results };
	}
	const brian = await db
		.prepare(`SELECT id, name FROM brians WHERE id = ? AND visibility = 'public'`)
		.bind(brianId)
		.first<{ id: string; name: string }>();
	return brian ? { member: false, brian: { ...brian, visibility: 'public' } } : null;
}

export async function setVisibility(db: D1Database, userId: string, brianId: string, visibility: Visibility): Promise<Outcome> {
	if (visibility !== 'private' && visibility !== 'public') return no('Unknown visibility.');
	if (!(await owned(db, userId, brianId))) return no(NOT_FOUND);
	await db.prepare('UPDATE brians SET visibility = ? WHERE id = ?').bind(visibility, brianId).run();
	return done;
}

const isMemberRole = (role: string): role is 'editor' | 'viewer' => role === 'editor' || role === 'viewer';

/** The owner adds someone by username. They're in at once: the brian appears in their Brian. */
export async function addMember(env: Bindings, userId: string, brianId: string, username: string, role: string): Promise<Outcome> {
	if (!isMemberRole(role)) return no('Members are editors or viewers.');
	const brian = await owned(env.DB, userId, brianId);
	if (!brian) return no(NOT_FOUND);
	const user = await userByUsername(env.DB, username);
	if (!user) return no(`No one is called "${normalizeName(username)}".`);
	if (await membership(env.DB, user.id, brianId)) return no(`${user.username} is already a member.`);
	const added = await insertMember(env, brian, user.id, role);
	return added.ok ? done : added;
}

export async function setRole(env: Bindings, userId: string, brianId: string, username: string, role: string): Promise<Outcome> {
	const db = env.DB;
	if (!isMemberRole(role)) return no('Members are editors or viewers.');
	if (!(await owned(db, userId, brianId))) return no(NOT_FOUND);
	const user = await userByUsername(db, username);
	if (!user || user.id === userId) return no(`${normalizeName(username)} isn't a member you can change.`);
	const result = await db
		.prepare(`UPDATE members SET role = ? WHERE brian_id = ? AND user_id = ? AND role != 'owner'`)
		.bind(role, brianId, user.id)
		.run();
	if (!result.meta.changes) return no(`${user.username} isn't a member.`);
	await kick(env, brianId, user.id);
	return done;
}

export async function removeMember(env: Bindings, userId: string, brianId: string, username: string): Promise<Outcome> {
	const db = env.DB;
	if (!(await owned(db, userId, brianId))) return no(NOT_FOUND);
	const user = await userByUsername(db, username);
	if (!user || user.id === userId) return no(`${normalizeName(username)} isn't a member you can remove.`);
	const result = await db
		.prepare(`DELETE FROM members WHERE brian_id = ? AND user_id = ? AND role != 'owner'`)
		.bind(brianId, user.id)
		.run();
	if (!result.meta.changes) return no(`${user.username} isn't a member.`);
	await kick(env, brianId, user.id);
	return done;
}

/** "Sync to this brian": anyone can join a public brian, as a viewer. */
export async function join(env: Bindings, userId: string, brianId: string): Promise<Outcome<BrianSummary>> {
	const brian = await env.DB.prepare(`SELECT id, name FROM brians WHERE id = ? AND visibility = 'public'`)
		.bind(brianId)
		.first<{ id: string; name: string }>();
	if (!brian) return no(NOT_FOUND);
	const existing = await membership(env.DB, userId, brianId);
	if (existing) return ok(existing);
	const joined = await insertMember(env, brian, userId, 'viewer');
	if (!joined.ok) return joined;
	return ok({ ...brian, visibility: 'public', role: 'viewer', mount: joined.value });
}

/** Members leave. The owner can't: they delete the brian instead. */
export async function leave(env: Bindings, userId: string, brianId: string): Promise<Outcome> {
	const db = env.DB;
	const mine = await membership(db, userId, brianId);
	if (!mine) return no(NOT_FOUND);
	if (mine.role === 'owner') return no("Owners can't leave their own brian. Delete it instead.");
	await db.prepare('DELETE FROM members WHERE brian_id = ? AND user_id = ?').bind(brianId, userId).run();
	await kick(env, brianId, userId);
	return done;
}

/**
 * Renames the folder a shared brian appears under in this user's own Brian (brian/<mount>/), as
 * when they rename it in Obsidian. Only their own membership changes; nobody else's folder does.
 */
export async function setMount(env: Bindings, userId: string, brianId: string, input: string): Promise<Outcome<string>> {
	const mine = await membership(env.DB, userId, brianId);
	if (!mine) return no(NOT_FOUND);
	const mount = normalizeName(input);
	if (mount === mine.mount) return ok(mount);
	if (!isValidName(mount)) return no(`Shared brians' folders are ${NAME_RULES}`);
	if (mount === (await usernameOf(env.DB, userId))) return no('That folder is where your agents keep their notes.');
	if ((await membershipsOf(env.DB, userId)).some((m) => m.mount === mount)) return no('Another shared brian already has that folder.');
	const { folders, files } = await env.VAULT.getByName(userId).list(`brian/${mount}/`);
	if (folders.length || files.length) return no(`brian/${mount}/ already holds notes of your own.`);
	try {
		await env.DB.prepare('UPDATE members SET mount = ? WHERE brian_id = ? AND user_id = ?').bind(mount, brianId, userId).run();
	} catch (error) {
		if (String(error).includes('UNIQUE')) return no('Another shared brian already has that folder.');
		throw error;
	}
	return ok(mount);
}

/** Closes the user's sync sockets to a brian, so a new role (or none) applies at once. */
async function kick(env: Bindings, brianId: string, userId: string): Promise<void> {
	await env.VAULT.getByName(brianId).kick(userId);
}

/** Erases the brian's pages for every member. Owner only. */
export async function deleteBrian(env: Bindings, userId: string, brianId: string): Promise<Outcome> {
	if (!(await owned(env.DB, userId, brianId))) return no(NOT_FOUND);
	await destroyBrian(env, brianId);
	return done;
}

async function destroyBrian(env: Bindings, brianId: string): Promise<void> {
	// Rows first, so no one is routed to the brian while its pages are erased.
	await env.DB.batch([
		env.DB.prepare('DELETE FROM members WHERE brian_id = ?').bind(brianId),
		env.DB.prepare('DELETE FROM brians WHERE id = ?').bind(brianId)
	]);
	await env.VAULT.getByName(brianId).destroy();
}

/**
 * Starts a new user's Brian once they have a username: writes brian/BRIAN.md unless it's
 * already there (e.g. from the Obsidian plugin). Never overwrites.
 */
export async function setUp(env: Bindings, userId: string): Promise<void> {
	const username = await usernameOf(env.DB, userId);
	if (!username) return;
	// A create-only write: it fails, harmlessly, if the page already exists.
	await env.VAULT.getByName(userId)
		.write('brian/BRIAN.md', personalBrianMd(username))
		.catch((error: Error) => {
			if (!/already exists/.test(error.message)) throw error;
		});
}

/** For account deletion: erases the brians the user owns and leaves the rest. */
export async function removeUserFromBrians(env: Bindings, userId: string): Promise<void> {
	const brians = await membershipsOf(env.DB, userId);
	for (const brian of brians) {
		if (brian.role === 'owner') await destroyBrian(env, brian.id);
	}
	await env.DB.prepare('DELETE FROM members WHERE user_id = ?').bind(userId).run();
	for (const brian of brians) if (brian.role !== 'owner') await kick(env, brian.id, userId);
}
