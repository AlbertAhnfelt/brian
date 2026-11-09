import type { SyncBrian, SyncSession } from '@brian/sync';
import { setMount } from '../brian/members';
import { Brian } from '../brian/router';
import type { Props } from '../props';

/** A personal brian is named by its user id, a shared one by "b_" and its id. */
const BRIAN_NAME = /^(b_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * POST /mcp/sync, behind the OAuth token like MCP itself: one sync ticket per brian the user is in,
 * issued by that brian's Durable Object with the role the user has there right now.
 */
export async function syncSession(request: Request, env: Env, props: Props): Promise<Response> {
	// ?brian=<id> (or "personal") asks for one ticket, for reconnecting a single brian.
	const only = new URL(request.url).searchParams.get('brian');
	const brian = await Brian.load(env, props.userId, props.client || 'Obsidian');
	if (!brian.username) return Response.json({ error: 'Pick a username first.' }, { status: 409 });
	const wanted = (id: string | null) => only === null || only === (id ?? 'personal');
	const brians: SyncBrian[] = await Promise.all([
		...(wanted(null) ? [null] : []).map(async () => ({
			id: null,
			name: brian.username!,
			mount: null,
			role: 'owner' as const,
			ticket: `${props.userId}.${await env.VAULT.getByName(props.userId).issueTicket(props.userId, props.email, props.client || 'Obsidian', 'owner')}`
		})),
		...brian.brians.filter((b) => wanted(b.id)).map(async (b) => ({
			id: b.id,
			name: b.name,
			mount: b.mount,
			role: b.role,
			ticket: `${b.id}.${await env.VAULT.getByName(b.id).issueTicket(props.userId, props.email, props.client || 'Obsidian', b.role)}`
		}))
	]);
	return Response.json({ username: brian.username, brians } satisfies SyncSession, { headers: { 'Cache-Control': 'no-store' } });
}

/** POST /mcp/sync/mount {brian, mount}: the user renamed a shared brian's folder in Obsidian. */
export async function syncMount(request: Request, env: Env, props: Props): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { brian?: unknown; mount?: unknown } | null;
	if (typeof body?.brian !== 'string' || typeof body.mount !== 'string') return Response.json({ error: 'Send "brian" and "mount".' }, { status: 400 });
	const outcome = await setMount(env, props.userId, body.brian, body.mount);
	return outcome.ok ? Response.json({ mount: outcome.value }) : Response.json({ error: outcome.message }, { status: 409 });
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
