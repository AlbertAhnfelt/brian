/**
 * Every tunable amount in Brian, in one place. Change a limit here and the code, the error
 * messages and the tool descriptions follow.
 */
export const LIMITS = {
	/** Pages in one brian (personal or shared). Also keeps exports, built in memory, manageable. */
	pagesPerBrian: 10_000,
	/**
	 * Size of one page, in UTF-8 bytes. Cloudflare documents a 2 MB row cap for Durable Object
	 * SQLite, but on prod (probed 2026-11-16) a 5 MB value plus a max-length path stored fine and
	 * 10 MB was refused (SQLITE_TOOBIG). Raising this also means checking MAX_STATE_BYTES and
	 * PULL_BYTES in apps/server/src/vault/vault.ts.
	 */
	pageBytes: 1_990_000,
	/** Length of a page path, in characters. */
	pathLength: 512,
	/** How long deleted pages stay in the trash. */
	trashDays: 30,
	/** Shared brians a user can be a member of, owner or not. Search asks each one, so keep it modest. */
	sharedBriansPerUser: 50,
	/** Folder names tried for a new member (`acme`, `acme-2`, …) before giving up. */
	folderNameAttempts: 20,
	/** Most search hits returned at once. */
	searchResults: 50,
	/** Most changes returned by one change-feed call. */
	changesPerCall: 1000,
	/** How long a website login lasts. */
	sessionDays: 30
} as const;
