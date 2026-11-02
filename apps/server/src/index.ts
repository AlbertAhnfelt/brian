import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { env } from 'cloudflare:workers';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { SCOPE } from './props';

export default new OAuthProvider<Env>({
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
});

export { Vault } from './vault/vault';
