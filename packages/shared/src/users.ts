export type Provider = 'google' | 'github' | 'apple';

export interface User {
	id: string;
	email: string;
	name: string | null;
	/** Null until the user picks one, right after their first login. */
	username: string | null;
}

/** What a login provider tells us about the person. `email` must be verified by the provider. */
export interface Profile {
	provider: Provider;
	providerUserId: string;
	email: string;
	name: string | null;
}

/**
 * Finds or creates the user for a provider login. A provider account that isn't linked yet
 * always gets a new user: matching emails are never joined automatically, because whoever
 * later controls an old address (a reassigned mailbox, a lapsed domain) could take over the
 * account. Linking happens only from a signed-in session, with linkLogin().
 */
export async function signIn(db: D1Database, profile: Profile): Promise<User> {
	const known = await db
		.prepare(
			`SELECT users.id, users.email, users.name, users.username FROM accounts
			 JOIN users ON users.id = accounts.user_id
			 WHERE accounts.provider = ? AND accounts.provider_user_id = ?`
		)
		.bind(profile.provider, profile.providerUserId)
		.first<User>();
	if (known) return known;

	const email = profile.email.toLowerCase();
	const user: User = { id: crypto.randomUUID(), email, name: profile.name, username: null };
	await db.batch([
		db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').bind(user.id, user.email, user.name),
		db
			.prepare('INSERT INTO accounts (provider, provider_user_id, user_id, email) VALUES (?, ?, ?, ?)')
			.bind(profile.provider, profile.providerUserId, user.id, email)
	]);
	return user;
}

/**
 * Adds a provider login to an existing, signed-in user. Returns 'taken' if that provider
 * account already belongs to someone else.
 */
export async function linkLogin(db: D1Database, userId: string, profile: Profile): Promise<'linked' | 'taken'> {
	await db
		.prepare(
			`INSERT INTO accounts (provider, provider_user_id, user_id, email) VALUES (?, ?, ?, ?)
			 ON CONFLICT (provider, provider_user_id) DO NOTHING`
		)
		.bind(profile.provider, profile.providerUserId, userId, profile.email.toLowerCase())
		.run();
	const owner = await db
		.prepare('SELECT user_id FROM accounts WHERE provider = ? AND provider_user_id = ?')
		.bind(profile.provider, profile.providerUserId)
		.first<string>('user_id');
	return owner === userId ? 'linked' : 'taken';
}
