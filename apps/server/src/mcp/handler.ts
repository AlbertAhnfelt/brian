import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { loginAllowed } from '@brian/shared';
import { createMcpHandler } from 'agents/mcp/server';
import { tooMany } from '../limits';
import { SCOPE, type Props } from '../props';
import { syncMount, syncSession } from '../sync/handler';
import { createServer } from './server';

const handler = createMcpHandler(createServer);

export const mcpHandler = {
	fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
		const ctx = executionCtx as OAuthResourceContext<Props>;
		if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
		// Tokens issued before an email left the allowlist stop working too.
		if (!loginAllowed(env, ctx.props.email)) return new Response('Forbidden', { status: 403 });
		return limitMcp(request, env, ctx);
	}
};

/** Per user, whatever app they come through: MCP tool calls and sync tickets. */
async function limitMcp(request: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
	if (!(await env.MCP_LIMITER.limit({ key: ctx.props.userId })).success) return tooMany('requests to your Brian');
	const path = new URL(request.url).pathname;
	if (path === '/mcp/sync' || path === '/mcp/sync/mount') {
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
		return path === '/mcp/sync' ? syncSession(request, env, ctx.props) : syncMount(request, env, ctx.props);
	}
	return handler(request, env, ctx);
}
