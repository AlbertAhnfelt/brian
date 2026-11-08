/** Stored with each grant by completeAuthorization() and handed to the MCP server. */
export interface Props extends Record<string, unknown> {
	userId: string;
	email: string;
	/**
	 * The app's name as it registered itself ("Claude"), saved at consent. Self-declared, so only a
	 * label for page history: escape it wherever it's shown. Missing on grants from before it existed.
	 */
	client?: string;
}

/** The scope every MCP client needs. */
export const SCOPE = 'brian';
