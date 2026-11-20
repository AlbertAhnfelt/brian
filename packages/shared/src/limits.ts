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
	/** How long deleted pages, and deleted shared brians, stay in the trash. */
	trashDays: 30,
	/** Shared brians a user can be a member of, owner or not. Search asks each one, so keep it modest. */
	sharedBriansPerUser: 50,
	/** Invitations to one brian waiting for an answer (to accounts and to email addresses together). */
	openInvitesPerBrian: 100,
	/** Folder names tried for a new member (`acme`, `acme-2`, …) before giving up. */
	folderNameAttempts: 20,
	/** Most search hits returned at once. */
	searchResults: 50,
	/** Most changes returned by one change-feed call. */
	changesPerCall: 1000,
	/** How long a website login lasts. */
	sessionDays: 30,
	/**
	 * Storage per user: their personal brian plus the shared brians they own (trash included).
	 * Counts page text, trash and sync state. Past it, writes that add data are refused.
	 */
	storageBytesPerUser: 3 * 1024 ** 3,
	/** Agents are warned once a user's storage passes this share of storageBytesPerUser. */
	storageWarnShare: 0.9,
	/** Shared brians one user can own, the ones in the trash included. */
	ownedBriansPerUser: 20
} as const;

/** A size for people: "2.7 GB", "512 MB". */
export function formatBytes(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
	return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
