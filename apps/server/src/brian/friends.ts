import { normalizeName, type Outcome, type Person } from '@brian/shared';

/**
 * Friends: people a user has added, to find again when sharing a brian. Search only finds exact
 * matches (a whole username or a whole email address), so it can't be used to browse users, and it
 * shows the username, never the email.
 */

const ok: Outcome = { ok: true, value: undefined };
const no = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** The person with exactly this username or email address, or null. Users without a username can't be found. */
export async function findPerson(db: D1Database, userId: string, input: string): Promise<Person | null> {
	const query = input.trim();
	if (!query || query.length > 254) return null;
	const found = query.includes('@')
		? await db
				.prepare(
					`SELECT id, username FROM users WHERE username IS NOT NULL
					 AND (email = ?1 OR id IN (SELECT user_id FROM accounts WHERE email = ?1)) LIMIT 1`
				)
				.bind(query.toLowerCase())
				.first<{ id: string; username: string }>()
		: await db.prepare('SELECT id, username FROM users WHERE username = ?').bind(normalizeName(query)).first<{ id: string; username: string }>();
	if (!found) return null;
	const friend = await db.prepare('SELECT 1 AS yes FROM friends WHERE user_id = ? AND friend_id = ?').bind(userId, found.id).first('yes');
	return { username: found.username, you: found.id === userId, friend: Boolean(friend) };
}

/** Usernames of the user's friends, alphabetically. */
export async function friendsOf(db: D1Database, userId: string): Promise<string[]> {
	const rows = await db
		.prepare(
			`SELECT users.username FROM friends JOIN users ON users.id = friends.friend_id
			 WHERE friends.user_id = ? AND users.username IS NOT NULL ORDER BY users.username`
		)
		.bind(userId)
		.all<{ username: string }>();
	return rows.results.map((r) => r.username);
}

export async function addFriend(db: D1Database, userId: string, username: string): Promise<Outcome> {
	const friend = await db.prepare('SELECT id FROM users WHERE username = ?').bind(normalizeName(username)).first<string>('id');
	if (!friend) return no('No such user.');
	if (friend === userId) return no("That's you.");
	await db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(userId, friend).run();
	return ok;
}

export async function removeFriend(db: D1Database, userId: string, username: string): Promise<Outcome> {
	await db
		.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = (SELECT id FROM users WHERE username = ?)')
		.bind(userId, normalizeName(username))
		.run();
	return ok;
}
