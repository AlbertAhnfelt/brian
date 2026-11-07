/**
 * Every tunable amount in Brian, in one place. Change a limit here and the code, the error
 * messages and the tool descriptions follow.
 */
export const LIMITS = {
	/** Pages in one brian (personal or shared). Also keeps exports, built in memory, manageable. */
	pagesPerBrian: 10_000,
	/** Size of one page, in UTF-8 bytes. */
	pageBytes: 1024 * 1024,
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
