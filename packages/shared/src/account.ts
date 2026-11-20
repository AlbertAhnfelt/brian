import type { ActivityFilter, ActivityPage } from './activity';
import type { ReaderHit, ReaderView } from './reader';
import type { BrianSummary, BrianView, DeletedBrian, Invite, Invited, Outcome, Role, Visibility } from './brians';

/** A connected app (Claude, ChatGPT, …) as shown on the account page. */
export interface Connection {
	grantId: string;
	clientName: string;
	createdAt: number;
}

export interface ExportedPage {
	path: string;
	content: string;
	updatedAt: number;
}

/**
 * The server's `Account` RPC entrypoint, as the website calls it over the SERVER service binding.
 * The website passes the user ID from its own verified session.
 */
/** Someone found by an exact username or email search. Never includes their email. */
export interface Person {
	username: string;
	/** The search found the signed-in user themselves. */
	you: boolean;
	/** Already in the signed-in user's friends. */
	friend: boolean;
}

export interface AccountRpc {
	connections(userId: string): Promise<Connection[]>;
	disconnect(userId: string, grantId: string): Promise<void>;
	exportPages(userId: string): Promise<ExportedPage[]>;
	deleteAccount(userId: string): Promise<void>;

	/** Starts the user's Brian once they have a username (writes brian/BRIAN.md if missing). */
	setUp(userId: string): Promise<void>;

	// Shared brians. Every call acts as `userId` and checks that user's role itself.
	brians(userId: string): Promise<BrianSummary[]>;
	viewBrian(userId: string, brianId: string): Promise<BrianView | null>;
	createBrian(userId: string, name: string, visibility: Visibility): Promise<Outcome<BrianSummary>>;
	setVisibility(userId: string, brianId: string, visibility: Visibility): Promise<Outcome>;
	/**
	 * The owner invites someone by username or email address. They become a member only when they
	 * accept. An email with no account behind it waits until someone signs in with it.
	 */
	invite(userId: string, brianId: string, who: string, role: Exclude<Role, 'owner'>): Promise<Outcome<Invited>>;
	/** Takes back an unanswered invitation, by username or by the email address invited. */
	cancelInvite(userId: string, brianId: string, who: string): Promise<Outcome>;
	/** Invitations waiting for this user's answer, newest first. */
	invites(userId: string): Promise<Invite[]>;
	acceptInvite(userId: string, brianId: string): Promise<Outcome<BrianSummary>>;
	declineInvite(userId: string, brianId: string): Promise<Outcome>;
	setRole(userId: string, brianId: string, username: string, role: Exclude<Role, 'owner'>): Promise<Outcome>;
	removeMember(userId: string, brianId: string, username: string): Promise<Outcome>;
	/** "Sync to this brian": join a public brian as a viewer. */
	join(userId: string, brianId: string): Promise<Outcome<BrianSummary>>;
	leave(userId: string, brianId: string): Promise<Outcome>;
	/** Moves the brian to the trash for LIMITS.trashDays, for every member. Owner only. */
	deleteBrian(userId: string, brianId: string): Promise<Outcome>;
	/** The brians this user deleted that are still in the trash, newest first. */
	deletedBrians(userId: string): Promise<DeletedBrian[]>;
	/** Brings a brian back from the trash, with its members. Owner only. */
	restoreBrian(userId: string, brianId: string): Promise<Outcome<BrianSummary>>;

	/** Who changed what, newest first, in the user's brian and the shared brians they're in. */
	activity(userId: string, filter?: ActivityFilter): Promise<ActivityPage>;
	/** Undoes one Activity entry (by its `key`). The message says what was done. */
	undo(userId: string, key: string): Promise<Outcome<string>>;

	/** Whether the user's agents (MCP apps) may create, share, change and delete brians. */
	agentsManageBrians(userId: string): Promise<boolean>;
	setAgentsManageBrians(userId: string, allowed: boolean): Promise<void>;

	// Friends: exact-match search by username or email, and a one-way list.
	findPerson(userId: string, query: string): Promise<Person | null>;
	friends(userId: string): Promise<string[]>;
	addFriend(userId: string, username: string): Promise<Outcome>;
	removeFriend(userId: string, username: string): Promise<Outcome>;

	/**
	 * Reading on the website. `brianId` null reads the user's whole Brian (shared brians in
	 * brian/<mount>/); a brian ID reads that brian alone, for its members, or for anyone when it's
	 * public: `userId` is null for someone not signed in. `path` is a page ("notes/idea.md") or a
	 * folder ("notes", "" for the root). Null when there's nothing there or the reader may not see it.
	 */
	readView(userId: string | null, brianId: string | null, path: string): Promise<ReaderView | null>;
	/** Full-text search over the same pages, best matches first. Null as for readView. */
	readSearch(userId: string | null, brianId: string | null, query: string): Promise<ReaderHit[] | null>;
}
