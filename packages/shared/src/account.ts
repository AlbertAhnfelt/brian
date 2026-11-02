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
}
