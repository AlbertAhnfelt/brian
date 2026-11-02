import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

declare global {
	interface Env {
		/** Injected by OAuthProvider into the default handler. */
		OAUTH_PROVIDER: OAuthHelpers;
	}
}
