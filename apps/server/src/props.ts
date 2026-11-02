/** Stored with each grant by completeAuthorization() and handed to the MCP server. */
export interface Props extends Record<string, unknown> {
	userId: string;
	email: string;
}

/** The scope every MCP client needs. */
export const SCOPE = 'brian';
