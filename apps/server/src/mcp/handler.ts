import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { loginAllowed } from '@brian/shared';
import { createMcpHandler } from 'agents/mcp/server';
import { SCOPE, type Props } from '../props';
import { syncSession } from '../sync/handler';
import { createServer } from './server';

const handler = createMcpHandler(createServer);

export const mcpHandler = {
	fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
		const ctx = executionCtx as OAuthResourceContext<Props>;
		if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
		// Tokens issued before an email left the allowlist stop working too.
		if (!loginAllowed(env, ctx.props.email)) return new Response('Forbidden', { status: 403 });
		if (new URL(request.url).pathname === '/mcp/sync') {
			return request.method === 'POST' ? syncSession(env, ctx.props) : new Response('Method not allowed', { status: 405 });
		}
		return handler(request, env, ctx);
	}
};
