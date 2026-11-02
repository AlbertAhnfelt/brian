import { createSession, pkceChallenge, SESSION_COOKIE, signIn, type User } from '@brian/shared';
import { env, exports } from 'cloudflare:workers';

export const ORIGIN = env.BASE_URL;
export const REDIRECT_URI = 'http://localhost:6274/callback';

/** Calls the Worker under test without following redirects. */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
	const url = new URL(path, ORIGIN);
	// Real requests always carry Host; the MCP handler checks it against DNS rebinding.
	const headers = new Headers(init.headers);
	headers.set('Host', url.host);
	return exports.default.fetch(url, { redirect: 'manual', ...init, headers });
}

/** A minimal cookie jar: remembers Set-Cookie values and sends them back. */
export class Jar {
	private cookies = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [name, value] of Object.entries(initial)) this.cookies.set(name, value);
	}

	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
	}

	store(response: Response): void {
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(';');
			const [name, ...value] = pair.split('=');
			this.cookies.set(name.trim(), value.join('='));
		}
	}

	async fetch(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('Cookie', this.header());
		const response = await call(path, { ...init, headers });
		this.store(response);
		return response;
	}
}

/** A user with a website session, as if they had logged in with GitHub. */
export async function signedInUser(email: string): Promise<{ user: User; jar: Jar }> {
	const user = await signIn(env.DB, { provider: 'github', providerUserId: email, email, name: null });
	const token = await createSession(env.DB, user.id);
	return { user, jar: new Jar({ [SESSION_COOKIE]: token }) };
}

export async function registerClient(name = 'Test client'): Promise<string> {
	const response = await call('/oauth/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
	});
	return ((await response.json()) as { client_id: string }).client_id;
}

export async function authorizeUrl(clientId: string, verifier: string): Promise<string> {
	const url = new URL('/authorize', ORIGIN);
	url.search = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: 'brian',
		state: 'client-state',
		code_challenge: await pkceChallenge(verifier),
		code_challenge_method: 'S256',
		resource: `${ORIGIN}/mcp`
	}).toString();
	return url.pathname + url.search;
}

export const consentHandle = (html: string) => /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '';

/** Runs the whole connect flow for a signed-in user and returns an MCP access token. */
export async function connect(jar: Jar): Promise<string> {
	const clientId = await registerClient();
	const verifier = 'v'.repeat(50);
	const consent = await jar.fetch(await authorizeUrl(clientId, verifier));
	const handle = consentHandle(await consent.text());
	const approved = await jar.fetch('/authorize', {
		method: 'POST',
		body: new URLSearchParams({ handle, decision: 'approve' })
	});
	const code = new URL(approved.headers.get('Location')!).searchParams.get('code')!;
	const token = await call('/oauth/token', {
		method: 'POST',
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			resource: `${ORIGIN}/mcp`
		})
	});
	return ((await token.json()) as { access_token: string }).access_token;
}

/** Calls an MCP tool and returns its text and whether it was an error. */
export async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
	const response = await call('/mcp', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
	});
	const body = await response.text();
	const json = JSON.parse(body.startsWith('{') ? body : /^data: (.*)$/m.exec(body)![1]);
	if (!json.result) throw new Error(`MCP ${response.status}: ${body}`);
	if (!json.result) throw new Error(`MCP ${response.status}: ${body}`);
	return {
		text: (json.result.content as { text: string }[]).map((c) => c.text).join('\n'),
		isError: Boolean(json.result.isError)
	};
}

/** Awaits a call that should fail and returns its message (Durable Object RPC rejections). */
export async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('Expected the call to fail');
}
