import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { SCOPE, type Props } from '../props';
import { createServer } from './server';

const handler = createMcpHandler(createServer);

export const mcpHandler = {
	fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
		const ctx = executionCtx as OAuthResourceContext<Props>;
		if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
		return handler(request, env, ctx);
	}
};
