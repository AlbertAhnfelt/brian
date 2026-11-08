import type { SyncBrian, SyncSession } from '@brian/sync';
import { Brian } from '../brian/router';
import type { Props } from '../props';

/** A personal brian is named by its user id, a shared one by "b_" and its id. */
const BRIAN_NAME = /^(b_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * POST /mcp/sync, behind the OAuth token like MCP itself: one sync ticket per brian the user is in,
 * issued by that brian's Durable Object with the role the user has there right now.
 */
export async function syncSession(env: Env, props: Props): Promise<Response> {
	const brian = await Brian.load(env, props.userId, props.client || 'Obsidian');
	if (!brian.username) return Response.json({ error: 'Pick a username first.' }, { status: 409 });
	const brians: SyncBrian[] = await Promise.all([
		(async () => ({
			id: null,
			name: brian.username!,
			mount: null,
			role: 'owner' as const,
			ticket: `${props.userId}.${await env.VAULT.getByName(props.userId).issueTicket(props.userId, props.email, props.client || 'Obsidian', 'owner')}`
		}))(),
		...brian.brians.map(async (b) => ({
			id: b.id,
			name: b.name,
			mount: b.mount,
			role: b.role,
			ticket: `${b.id}.${await env.VAULT.getByName(b.id).issueTicket(props.userId, props.email, props.client || 'Obsidian', b.role)}`
		}))
	]);
	return Response.json({ username: brian.username, brians } satisfies SyncSession, { headers: { 'Cache-Control': 'no-store' } });
}

/** GET /sync/socket?ticket=<brian>.<secret>: hands the WebSocket to that brian's Durable Object, which checks the ticket. */
export function syncSocket(request: Request, env: Env): Promise<Response> | Response {
	if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
	const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
	const dot = ticket.indexOf('.');
	const name = ticket.slice(0, dot);
	if (dot < 0 || !BRIAN_NAME.test(name)) return new Response('This sync ticket is invalid or has expired.', { status: 401 });
	return env.VAULT.getByName(name).fetch(request);
}
