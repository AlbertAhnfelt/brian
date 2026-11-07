import type { BrianSummary, BrianView, Outcome, Role, Visibility } from './brians';

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
export interface AccountRpc {
	connections(userId: string): Promise<Connection[]>;
	disconnect(userId: string, grantId: string): Promise<void>;
	exportPages(userId: string): Promise<ExportedPage[]>;
	deleteAccount(userId: string): Promise<void>;

	// Shared brians. Every call acts as `userId` and checks that user's role itself.
	brians(userId: string): Promise<BrianSummary[]>;
	viewBrian(userId: string, brianId: string): Promise<BrianView | null>;
	createBrian(userId: string, name: string, visibility: Visibility): Promise<Outcome<BrianSummary>>;
	setVisibility(userId: string, brianId: string, visibility: Visibility): Promise<Outcome>;
	addMember(userId: string, brianId: string, username: string, role: Exclude<Role, 'owner'>): Promise<Outcome>;
	setRole(userId: string, brianId: string, username: string, role: Exclude<Role, 'owner'>): Promise<Outcome>;
	removeMember(userId: string, brianId: string, username: string): Promise<Outcome>;
	/** "Sync to this brian": join a public brian as a viewer. */
	join(userId: string, brianId: string): Promise<Outcome<BrianSummary>>;
	leave(userId: string, brianId: string): Promise<Outcome>;
	deleteBrian(userId: string, brianId: string): Promise<Outcome>;
}
