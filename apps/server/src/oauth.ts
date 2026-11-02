import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { SCOPE } from './props';

export const oauthOptions: OAuthProviderOptions<Env> = {
	apiRoute: '/mcp',
	apiHandler: mcpHandler,
	defaultHandler: authHandler,
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/oauth/token',
	clientRegistrationEndpoint: '/oauth/register',
	clientIdMetadataDocumentEnabled: true,
	scopesSupported: [SCOPE],
	requiredScopes: [SCOPE],
	resourceMetadata: {
		resource: `${env.BASE_URL}/mcp`,
		authorization_servers: [env.BASE_URL]
	}
};
