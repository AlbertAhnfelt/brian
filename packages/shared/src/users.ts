export type Provider = 'google' | 'github' | 'apple';

export interface User {
	id: string;
	email: string;
	name: string | null;
}

/** What a login provider tells us about the person. `email` must be verified by the provider. */
export interface Profile {
	provider: Provider;
	providerUserId: string;
	email: string;
	name: string | null;
}

/**
 * Finds or creates the user for a provider login. A new provider account joins an existing
 * user with the same verified email; otherwise a new user is created.
 */
export async function signIn(db: D1Database, profile: Profile): Promise<User> {
	const known = await db
		.prepare(
			`SELECT users.id, users.email, users.name FROM accounts
			 JOIN users ON users.id = accounts.user_id
			 WHERE accounts.provider = ? AND accounts.provider_user_id = ?`
		)
		.bind(profile.provider, profile.providerUserId)
		.first<User>();
	if (known) return known;

	const email = profile.email.toLowerCase();
	const existing = await db
		.prepare('SELECT id, email, name FROM users WHERE email = ? ORDER BY created_at LIMIT 1')
		.bind(email)
		.first<User>();
	const user: User = existing ?? { id: crypto.randomUUID(), email, name: profile.name };

	const statements = [];
	if (!existing) {
		statements.push(
			db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').bind(user.id, user.email, user.name)
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO accounts (provider, provider_user_id, user_id, email) VALUES (?, ?, ?, ?)
				 ON CONFLICT (provider, provider_user_id) DO NOTHING`
			)
			.bind(profile.provider, profile.providerUserId, user.id, email)
	);
	await db.batch(statements);
	return user;
}
