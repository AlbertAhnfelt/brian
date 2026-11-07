/** Who may sign in. Set per environment: dev is restricted to its owners, local and prod are open. */
export interface AccessConfig {
	/** "true" restricts sign-in to ALLOWED_EMAILS. A plain var in wrangler.jsonc. */
	RESTRICT_LOGIN?: string;
	/** Comma-separated emails. A secret, so the addresses stay out of the repo. */
	ALLOWED_EMAILS?: string;
}

/**
 * True if this email may use the site. When restricted, an empty or missing list lets nobody in:
 * a forgotten secret must lock the environment, not open it.
 */
export function loginAllowed(config: AccessConfig, email: string): boolean {
	if (config.RESTRICT_LOGIN !== 'true') return true;
	const allowed = (config.ALLOWED_EMAILS ?? '')
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	return allowed.includes(email.trim().toLowerCase());
}
