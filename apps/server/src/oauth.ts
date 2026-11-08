import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { syncSocket } from './sync/handler';
import { SCOPE } from './props';

export const oauthOptions: OAuthProviderOptions<Env> = {
	apiRoute: '/mcp',
	apiHandler: mcpHandler,
	defaultHandler: {
		// The sync WebSocket carries a one-time ticket instead of the OAuth token (browsers can't
		// set headers on WebSockets), so it's routed here, outside the token-checked /mcp.
		fetch: (request, env, ctx) =>
			new URL(request.url).pathname === '/sync/socket' ? syncSocket(request, env) : authHandler.fetch(request, env)
	},
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/oauth/token',
	clientRegistrationEndpoint: '/oauth/register',
	clientIdMetadataDocumentEnabled: true,
	// The Obsidian plugin signs in with an obsidian:// redirect. PKCE keeps the code useless to any
	// other app that claims the scheme.
	allowPrivateUseRedirectUris: true,
	scopesSupported: [SCOPE],
	requiredScopes: [SCOPE],
	resourceMetadata: {
		resource: `${env.BASE_URL}/mcp`,
		authorization_servers: [env.BASE_URL]
	}
};
