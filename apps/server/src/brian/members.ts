import {
	isValidName,
	LIMITS,
	NAME_RULES,
	normalizeName,
	personalBrianMd,
	sharedBrianMd,
	type BrianSummary,
	type BrianView,
	type DeletedBrian,
	type Invite,
	type Invited,
	type Member,
	type SentInvite,
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
			 WHERE members.user_id = ? AND brians.deleted_at IS NULL ORDER BY members.mount`
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
			 WHERE members.user_id = ? AND members.brian_id = ? AND brians.deleted_at IS NULL`
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

/**
 * The user signed in with this email, if any (a provider-verified address, on any of their logins).
 * Users without a username count too: an invitation waits for them until they pick one.
 */
async function userByEmail(db: D1Database, email: string): Promise<{ id: string; username: string | null } | null> {
	return db
		.prepare(
			`SELECT id, username FROM users WHERE email = ?1 OR id IN (SELECT user_id FROM accounts WHERE email = ?1)
			 ORDER BY created_at LIMIT 1`
		)
		.bind(email)
		.first<{ id: string; username: string | null }>();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
		// Only into a brian that's live: one deleted meanwhile (while the folder name was chosen) takes no one.
		const added = await env.DB.prepare(
			`INSERT INTO members (brian_id, user_id, role, mount)
			 SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM brians WHERE id = ?1 AND deleted_at IS NULL)`
		)
			.bind(brian.id, userId, role, mount)
			.run();
		if (!added.meta.changes) return no(NOT_FOUND);
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
	await notify(env, userId);
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
		// Invitations to an account show its username; ones held for an email address show the address.
		const invites =
			mine.role === 'owner'
				? (
						await db
							.prepare(
								`SELECT COALESCE(users.username, invites.email, 'someone invited by email') AS who, invites.role FROM invites JOIN users ON users.id = invites.user_id
								 WHERE invites.brian_id = ?1
								 UNION ALL
								 SELECT email AS who, role FROM email_invites WHERE brian_id = ?1
								 ORDER BY who`
							)
							.bind(brianId)
							.all<SentInvite>()
					).results
				: [];
		return { member: true, brian: mine, members: members.results, invites };
	}
	const brian = await db
		.prepare(`SELECT id, name FROM brians WHERE id = ? AND visibility = 'public' AND deleted_at IS NULL`)
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

/**
 * The owner invites someone by username or by email address. Nothing reaches their Brian until they
 * accept: nobody can be put in a brian without saying yes. An email address nobody has signed in
 * with yet is held (email_invites) and becomes an invitation when someone signs in with it.
 */
export async function invite(env: Bindings, userId: string, brianId: string, who: string, role: string): Promise<Outcome<Invited>> {
	const db = env.DB;
	if (!isMemberRole(role)) return no('Members are editors or viewers.');
	if (!(await owned(db, userId, brianId))) return no(NOT_FOUND);
	const open = await db
		.prepare('SELECT (SELECT COUNT(*) FROM invites WHERE brian_id = ?1) + (SELECT COUNT(*) FROM email_invites WHERE brian_id = ?1) AS n')
		.bind(brianId)
		.first<number>('n');
	if ((open ?? 0) >= LIMITS.openInvitesPerBrian) {
		return no(`A brian can have at most ${LIMITS.openInvitesPerBrian} invitations waiting for an answer. Take some back first.`);
	}
	const input = who.trim();
	if (input.includes('@')) {
		const email = input.toLowerCase();
		if (email.length > 254 || !EMAIL.test(email)) return no(`${input} isn't an email address.`);
		const user = await userByEmail(db, email);
		if (user) {
			const sent = await inviteUser(db, userId, brianId, user.id, user.username ?? email, role, email);
			// Someone who hasn't picked a username can't be found by search either: the answer doesn't tell them apart.
			return sent.ok && !user.username ? ok('email') : sent;
		}
		const sent = await db
			.prepare('INSERT INTO email_invites (brian_id, email, role, invited_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
			.bind(brianId, email, role, userId)
			.run();
		return sent.meta.changes ? ok('email') : no(`${email} is already invited.`);
	}
	const user = await userByUsername(db, input);
	if (!user) return no(`Nobody has the username ${normalizeName(input)}. To invite someone without an account, use their email address.`);
	return inviteUser(db, userId, brianId, user.id, user.username, role, null);
}

/** `email`: the address typed, when the invitation went by email (shown to the owner instead of the account's own). */
async function inviteUser(
	db: D1Database,
	ownerId: string,
	brianId: string,
	userId: string,
	shown: string,
	role: 'editor' | 'viewer',
	email: string | null
): Promise<Outcome<Invited>> {
	if (userId === ownerId) return no("That's you.");
	if (await membership(db, userId, brianId)) return no(`${shown} is already a member.`);
	try {
		await db
			.prepare('INSERT INTO invites (brian_id, user_id, role, invited_by, email) VALUES (?, ?, ?, ?, ?)')
			.bind(brianId, userId, role, ownerId, email)
			.run();
	} catch (error) {
		if (String(error).includes('UNIQUE')) return no(`${shown} is already invited.`);
		throw error;
	}
	return ok('account');
}

/** The owner takes back an invitation that hasn't been answered, by username or by the email address invited. */
export async function cancelInvite(env: Bindings, userId: string, brianId: string, who: string): Promise<Outcome> {
	const db = env.DB;
	if (!(await owned(db, userId, brianId))) return no(NOT_FOUND);
	const input = who.trim();
	if (input.includes('@')) {
		const email = input.toLowerCase();
		await db.batch([
			db.prepare('DELETE FROM email_invites WHERE brian_id = ? AND email = ?').bind(brianId, email),
			db
				.prepare(
					`DELETE FROM invites WHERE brian_id = ?1 AND (email = ?2 OR user_id IN (SELECT id FROM users WHERE email = ?2 UNION SELECT user_id FROM accounts WHERE email = ?2))`
				)
				.bind(brianId, email)
		]);
	} else {
		await db
			.prepare('DELETE FROM invites WHERE brian_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)')
			.bind(brianId, normalizeName(input))
			.run();
	}
	return done;
}

/**
 * Turns invitations held for any of this user's (provider-verified) email addresses into
 * invitations to their account. Runs whenever they look at or answer their invitations.
 */
async function claimEmailInvites(db: D1Database, userId: string): Promise<void> {
	const emails = 'SELECT email FROM users WHERE id = ?1 UNION SELECT email FROM accounts WHERE user_id = ?1';
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO invites (brian_id, user_id, role, invited_by, created_at, email)
				 SELECT e.brian_id, ?1, e.role, e.invited_by, e.created_at, e.email FROM email_invites e
				 WHERE e.email IN (${emails}) AND e.invited_by != ?1
				 AND NOT EXISTS (SELECT 1 FROM members m WHERE m.brian_id = e.brian_id AND m.user_id = ?1)`
			)
			.bind(userId),
		db.prepare(`DELETE FROM email_invites WHERE email IN (${emails})`).bind(userId)
	]);
}

/** Invitations waiting for this user's answer, newest first. */
export async function invitesOf(db: D1Database, userId: string): Promise<Invite[]> {
	await claimEmailInvites(db, userId);
	const rows = await db
		.prepare(
			`SELECT brians.id AS brianId, brians.name AS brianName, invites.role, users.username AS "from", invites.created_at AS createdAt
			 FROM invites JOIN brians ON brians.id = invites.brian_id JOIN users ON users.id = invites.invited_by
			 WHERE invites.user_id = ? ORDER BY invites.created_at DESC`
		)
		.bind(userId)
		.all<Invite>();
	return rows.results;
}

/** The invited user says yes: they become a member with the role they were invited as. */
export async function acceptInvite(env: Bindings, userId: string, brianId: string): Promise<Outcome<BrianSummary>> {
	const db = env.DB;
	await claimEmailInvites(db, userId);
	const pending = await db
		.prepare(
			`SELECT brians.id, brians.name, invites.role FROM invites JOIN brians ON brians.id = invites.brian_id
			 WHERE invites.user_id = ? AND invites.brian_id = ?`
		)
		.bind(userId, brianId)
		.first<{ id: string; name: string; role: 'editor' | 'viewer' }>();
	if (!pending) return no('This invitation is no longer open.');
	const existing = await membership(db, userId, brianId);
	if (existing) {
		// Joined meanwhile (a public brian, as a viewer): the invitation's role applies.
		if (existing.role === 'viewer' && pending.role === 'editor') {
			await db.prepare(`UPDATE members SET role = 'editor' WHERE brian_id = ? AND user_id = ?`).bind(brianId, userId).run();
			await kick(env, brianId, userId);
		}
		await db.prepare('DELETE FROM invites WHERE brian_id = ? AND user_id = ?').bind(brianId, userId).run();
		return ok((await membership(db, userId, brianId))!);
	}
	const joined = await insertMember(env, pending, userId, pending.role);
	if (!joined.ok) return joined;
	await db.prepare('DELETE FROM invites WHERE brian_id = ? AND user_id = ?').bind(brianId, userId).run();
	await notify(env, userId);
	return ok((await membership(db, userId, brianId))!);
}

/** The invited user says no. The owner isn't told beyond the invitation disappearing. */
export async function declineInvite(env: Bindings, userId: string, brianId: string): Promise<Outcome> {
	await claimEmailInvites(env.DB, userId);
	await env.DB.prepare('DELETE FROM invites WHERE brian_id = ? AND user_id = ?').bind(brianId, userId).run();
	return done;
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
	const brian = await env.DB.prepare(`SELECT id, name FROM brians WHERE id = ? AND visibility = 'public' AND deleted_at IS NULL`)
		.bind(brianId)
		.first<{ id: string; name: string }>();
	if (!brian) return no(NOT_FOUND);
	const existing = await membership(env.DB, userId, brianId);
	if (existing) return ok(existing);
	const joined = await insertMember(env, brian, userId, 'viewer');
	if (!joined.ok) return joined;
	await notify(env, userId);
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
 * when they rename it in Obsidian. Only their own folder changes, nobody else's. When the owner
 * renames it, the brian's name follows.
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
		const moves = [env.DB.prepare('UPDATE members SET mount = ? WHERE brian_id = ? AND user_id = ?').bind(mount, brianId, userId)];
		// The owner renaming their folder renames the brian too; other members' folders keep their names.
		if (mine.role === 'owner') moves.push(env.DB.prepare('UPDATE brians SET name = ? WHERE id = ?').bind(mount, brianId));
		await env.DB.batch(moves);
	} catch (error) {
		if (String(error).includes('UNIQUE')) return no('Another shared brian already has that folder.');
		throw error;
	}
	return ok(mount);
}

/** Closes the user's sync sockets to a brian, so a new role (or none) applies at once. */
async function kick(env: Bindings, brianId: string, userId: string): Promise<void> {
	await env.VAULT.getByName(brianId).kick(userId, true);
}

/**
 * Tells the user's devices their list of brians changed (one joined, created or restored), by
 * closing their personal brian's sync socket with "membership changed": Obsidian then looks again
 * at once instead of at its next 5-minute check. A failure here never fails the change itself.
 */
export async function notify(env: Bindings, userId: string): Promise<void> {
	await env.VAULT.getByName(userId)
		.kick(userId)
		.catch((error: Error) => console.error('notify failed', error.message));
}

const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Moves the brian to the trash, for every member, for LIMITS.trashDays. Owner only. Its pages stay
 * in its Vault and its members are remembered (freeing their folder names meanwhile); open
 * invitations are dropped. The daily purge erases it once the time is up.
 */
export async function deleteBrian(env: Bindings, userId: string, brianId: string): Promise<Outcome> {
	const db = env.DB;
	if (!(await owned(db, userId, brianId))) return no(NOT_FOUND);
	const members = (await db.prepare('SELECT user_id FROM members WHERE brian_id = ?').bind(brianId).all<{ user_id: string }>()).results;
	await db.batch([
		db.prepare('DELETE FROM deleted_members WHERE brian_id = ?').bind(brianId),
		db.prepare('INSERT INTO deleted_members (brian_id, user_id, role, mount) SELECT brian_id, user_id, role, mount FROM members WHERE brian_id = ?').bind(brianId),
		db.prepare('DELETE FROM members WHERE brian_id = ?').bind(brianId),
		db.prepare('DELETE FROM invites WHERE brian_id = ?').bind(brianId),
		db.prepare('DELETE FROM email_invites WHERE brian_id = ?').bind(brianId),
		db.prepare('UPDATE brians SET deleted_at = ? WHERE id = ?').bind(now(), brianId)
	]);
	for (const member of members) await kick(env, brianId, member.user_id);
	return done;
}

/** The brians this user deleted (as their owner) that are still in the trash, newest first. */
export async function deletedBrians(db: D1Database, userId: string): Promise<DeletedBrian[]> {
	const rows = await db
		.prepare(
			`SELECT brians.id, brians.name, brians.deleted_at AS deletedAt FROM deleted_members
			 JOIN brians ON brians.id = deleted_members.brian_id
			 WHERE deleted_members.user_id = ? AND deleted_members.role = 'owner' AND brians.deleted_at > ?
			 ORDER BY brians.deleted_at DESC`
		)
		.bind(userId, now() - LIMITS.trashDays * DAY)
		.all<Omit<DeletedBrian, 'purgeAt'>>();
	return rows.results.map((b) => ({ ...b, purgeAt: b.deletedAt + LIMITS.trashDays * DAY }));
}

/**
 * Brings a brian back from the trash. Owner only. Every member gets their folder back (the old
 * name if it's still free); one who can't take another brian right now is invited back instead.
 */
export async function restoreBrian(env: Bindings, userId: string, brianId: string): Promise<Outcome<BrianSummary>> {
	const db = env.DB;
	const trashed = (await deletedBrians(db, userId)).find((b) => b.id === brianId);
	if (!trashed) return no('No such brian in your trash.');
	// Out of the trash first, and only while it's still in time: the purge never takes a live brian.
	const back = await db
		.prepare('UPDATE brians SET deleted_at = NULL WHERE id = ? AND deleted_at > ?')
		.bind(brianId, now() - LIMITS.trashDays * DAY)
		.run();
	if (!back.meta.changes) return no('No such brian in your trash.');
	const rows = (
		await db.prepare('SELECT user_id, role, mount FROM deleted_members WHERE brian_id = ?').bind(brianId).all<{ user_id: string; role: Role; mount: string }>()
	).results;
	// The owner first: if they have no room, it goes back in the trash as it was.
	const owner = await insertMember(env, { id: brianId, name: rows.find((r) => r.role === 'owner')?.mount ?? trashed.name }, userId, 'owner').catch(
		(error: Error) => no(error.message)
	);
	if (!owner.ok) {
		await db.prepare('UPDATE brians SET deleted_at = ? WHERE id = ?').bind(trashed.deletedAt, brianId).run();
		return owner;
	}
	await db.prepare('DELETE FROM deleted_members WHERE brian_id = ? AND user_id = ?').bind(brianId, userId).run();
	await notify(env, userId);
	for (const row of rows) {
		if (row.user_id === userId || row.role === 'owner') continue;
		try {
			const joined = await insertMember(env, { id: brianId, name: row.mount }, row.user_id, row.role);
			if (joined.ok) await notify(env, row.user_id);
			else await db.prepare('INSERT OR IGNORE INTO invites (brian_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)').bind(brianId, row.user_id, row.role, userId).run();
			await db.prepare('DELETE FROM deleted_members WHERE brian_id = ? AND user_id = ?').bind(brianId, row.user_id).run();
		} catch (error) {
			// Left in deleted_members: still on record, and the next try (or another delete) keeps them.
			console.error('restoring a member failed', (error as Error).message);
		}
	}
	return ok((await membership(db, userId, brianId))!);
}

/** Marks a brian as being erased: older than any trash window, so it can't be restored. */
const PURGING = 1;

/**
 * Erases the brians that have been in the trash longer than LIMITS.trashDays. Run daily. Each one
 * is marked first (so a restore can't take it back halfway), its pages are erased, and only then its
 * rows: if erasing fails, the next run tries again. One failure doesn't hold up the others.
 */
export async function purgeDeletedBrians(env: Bindings, at = now()): Promise<number> {
	const cutoff = at - LIMITS.trashDays * DAY;
	const expired = (
		await env.DB.prepare('SELECT id FROM brians WHERE deleted_at IS NOT NULL AND deleted_at <= ?').bind(cutoff).all<{ id: string }>()
	).results;
	let purged = 0;
	for (const { id } of expired) {
		try {
			const marked = await env.DB.prepare('UPDATE brians SET deleted_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?')
				.bind(PURGING, id, cutoff)
				.run();
			if (!marked.meta.changes) continue; // Restored meanwhile.
			await env.VAULT.getByName(id).destroy();
			await env.DB.prepare('DELETE FROM brians WHERE id = ? AND deleted_at = ?').bind(id, PURGING).run();
			purged++;
		} catch (error) {
			console.error(`purging ${id} failed`, (error as Error).message);
		}
	}
	return purged;
}

async function destroyBrian(env: Bindings, brianId: string): Promise<void> {
	// Rows first, so no one is routed to the brian while its pages are erased.
	await env.DB.batch([
		env.DB.prepare('DELETE FROM members WHERE brian_id = ?').bind(brianId),
		env.DB.prepare('DELETE FROM brians WHERE id = ?').bind(brianId)
	]);
	await env.VAULT.getByName(brianId).destroy();
}

/** Whether the user's agents may create, share, change and delete brians (the switch on /account). */
export async function agentsManageBrians(db: D1Database, userId: string): Promise<boolean> {
	return (await db.prepare('SELECT agents_manage_brians FROM users WHERE id = ?').bind(userId).first<number>('agents_manage_brians')) === 1;
}

export async function setAgentsManageBrians(db: D1Database, userId: string, allowed: boolean): Promise<void> {
	await db.prepare('UPDATE users SET agents_manage_brians = ? WHERE id = ?').bind(allowed ? 1 : 0, userId).run();
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
	// Brians they own that are in the trash go too; their place in others' trashed brians is forgotten.
	const trashed = await env.DB.prepare(`SELECT brian_id FROM deleted_members WHERE user_id = ? AND role = 'owner'`).bind(userId).all<{ brian_id: string }>();
	for (const { brian_id } of trashed.results) await destroyBrian(env, brian_id);
	await env.DB.batch([
		env.DB.prepare('DELETE FROM members WHERE user_id = ?').bind(userId),
		env.DB.prepare('DELETE FROM deleted_members WHERE user_id = ?').bind(userId)
	]);
	for (const brian of brians) if (brian.role !== 'owner') await kick(env, brian.id, userId);
}
