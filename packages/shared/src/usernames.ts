/**
 * Usernames name a user's personal brian and their agent folder (`brian/<username>/`), and will
 * address "send it to my Brian". The same rules name shared brians and their folders.
 */
export const NAME_RULES = '3–32 characters: lowercase letters, digits and single hyphens, starting and ending with a letter or digit.';

const NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,30}[a-z0-9]$/;

/** Not available as usernames: they would be confusing, look official, or clash with routes. */
const RESERVED = new Set([
	'about', 'account', 'admin', 'administrator', 'api', 'app', 'apps', 'auth', 'authorize', 'b', 'billing',
	'brian', 'brians', 'claude', 'connect', 'help', 'home', 'login', 'logout', 'mail', 'mcp', 'me', 'mod',
	'moderator', 'new', 'null', 'oauth', 'official', 'owner', 'privacy', 'root', 'security', 'settings',
	'staff', 'support', 'system', 'team', 'terms', 'undefined', 'welcome', 'www'
]);

/** Lowercases and trims, so "Albert " and "albert" are the same name. */
export function normalizeName(input: string): string {
	return input.trim().toLowerCase();
}

/** True if `name` (already normalized) follows NAME_RULES. */
export function isValidName(name: string): boolean {
	return NAME.test(name);
}

/** Why `name` can't be a username, or null if it can. */
export function usernameProblem(name: string): string | null {
	if (!isValidName(name)) return `Usernames are ${NAME_RULES}`;
	if (RESERVED.has(name)) return `"${name}" is reserved.`;
	return null;
}

/**
 * Sets a user's username. For now a username is chosen once and can't change, because it names
 * the `brian/<username>/` folder that agents write to.
 */
export async function setUsername(
	db: D1Database,
	userId: string,
	input: string
): Promise<{ ok: true; username: string } | { ok: false; message: string }> {
	const username = normalizeName(input);
	const problem = usernameProblem(username);
	if (problem) return { ok: false, message: problem };
	try {
		const result = await db
			.prepare('UPDATE users SET username = ? WHERE id = ? AND username IS NULL')
			.bind(username, userId)
			.run();
		if (result.meta.changes === 0) return { ok: false, message: 'Your username is already set.' };
	} catch (error) {
		if (String(error).includes('UNIQUE')) return { ok: false, message: `"${username}" is taken.` };
		throw error;
	}
	return { ok: true, username };
}
