/** What happened to pages (recorded by each brian's Durable Object). */
export type PageAction = 'create' | 'edit' | 'move' | 'delete' | 'restore';

/** What happened to a shared brian itself (recorded in D1). */
export type BrianAction =
	| 'brian.create'
	| 'brian.rename'
	| 'brian.visibility'
	| 'brian.invite'
	| 'brian.uninvite'
	| 'brian.accept'
	| 'brian.join'
	| 'brian.leave'
	| 'brian.role'
	| 'brian.remove'
	| 'brian.delete'
	| 'brian.restore';

export type ActivityAction = PageAction | BrianAction;

/**
 * One line on the Activity page. Page changes made in the same instant by the same author (a
 * folder moved, say) come as one entry with a `count`.
 */
export interface ActivityEntry {
	/** Opaque: hand it back to `undo`. */
	key: string;
	/** Milliseconds. */
	at: number;
	/** The username of who did it; null for an account that no longer exists. */
	who: string | null;
	you: boolean;
	/** What they used: "Claude", "Obsidian", "website"… Self-declared by apps, so only a label. */
	app: string;
	action: ActivityAction;
	/** The shared brian it happened in, or null for the user's own brian. */
	brian: { id: string; name: string } | null;
	/** Page changes: the page as it's shown in the user's Brian, or the folder holding them all when `count` > 1. */
	path?: string;
	/** Page moves of a single page: where it was. */
	fromPath?: string | null;
	count?: number;
	/** Brian changes: who it was about (a username, or an email address for invitations). */
	target?: string | null;
	/** Brian changes: the role given, and the earlier role or visibility it replaced. */
	role?: string | null;
	from?: string | null;
	/** Whether the person looking at it can undo it now. */
	undoable: boolean;
}

export interface ActivityFilter {
	/** A shared brian's id, or "personal" for the user's own brian. */
	brian?: string;
	/** A username. */
	person?: string;
	/** An app name, as entries show it. */
	app?: string;
	/** Only entries before this (milliseconds): the `before` of the previous page. */
	before?: number;
}

export interface ActivityPage {
	entries: ActivityEntry[];
	/** Pass as `before` for the next page; null when there's no more. */
	before: number | null;
}
