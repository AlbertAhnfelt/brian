import { randomToken, sha256Hex } from './crypto';
import { LIMITS } from './limits';
import type { User } from './users';

/** Website session cookie. The server's /authorize reads it too (same origin). */
export const SESSION_COOKIE = '__Host-brian_session';

/** Creates a session and returns the token for the cookie. Only its hash is stored. */
export async function createSession(db: D1Database, userId: string): Promise<string> {
	const token = randomToken();
	const expiresAt = Math.floor(Date.now() / 1000) + LIMITS.sessionDays * 24 * 60 * 60;
	await db
		.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)')
		.bind(await sha256Hex(token), userId, expiresAt)
		.run();
	return token;
}

export async function getSessionUser(db: D1Database, token: string | undefined | null): Promise<User | null> {
	if (!token) return null;
	return db
		.prepare(
			`SELECT users.id, users.email, users.name, users.username FROM sessions
			 JOIN users ON users.id = sessions.user_id
			 WHERE sessions.id_hash = ? AND sessions.expires_at > unixepoch()`
		)
		.bind(await sha256Hex(token))
		.first<User>();
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
	await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256Hex(token)).run();
}

/** Reads one cookie from a raw Cookie header (for Workers without a cookie helper). */
export function readCookie(header: string | null, name: string): string | null {
	for (const part of header?.split(';') ?? []) {
		const [key, ...value] = part.trim().split('=');
		if (key === name) return value.join('=');
	}
	return null;
}
