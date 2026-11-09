import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, call, connect, consentHandle, Jar, ORIGIN, registerClient, signedInUser, tool } from './helpers';

describe('discovery', () => {
	it('challenges unauthenticated MCP requests with the resource metadata', async () => {
		const response = await call('/mcp', { method: 'POST', body: '{}' });
		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
		);
	});

	it('publishes the resource and authorization server metadata', async () => {
		const resource = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
		expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
		const server = await (await call('/.well-known/oauth-authorization-server')).json();
		expect(server).toMatchObject({ issuer: ORIGIN, registration_endpoint: `${ORIGIN}/oauth/register` });
	});

	it('rejects invalid tokens', async () => {
		const response = await call('/mcp', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' });
		expect(response.status).toBe(401);
	});
});

describe('/authorize', () => {
	it('sends signed-out users to the website login and back', async () => {
		const path = await authorizeUrl(await registerClient(), 'v'.repeat(50));
		const response = await call(path);
		expect(response.status).toBe(302);
		const login = new URL(response.headers.get('Location')!);
		expect(login.origin + login.pathname).toBe(`${ORIGIN}/login`);
		expect(login.searchParams.get('next')).toBe(path);
	});

	it('shows a consent page that escapes the client name and cannot be framed', async () => {
		const { jar } = await signedInUser('consent@example.com');
		const response = await jar.fetch(await authorizeUrl(await registerClient('<script>x</script>'), 'v'.repeat(50)));
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain('&#60;script&#62;x&#60;/script&#62;');
		expect(html).not.toContain('<script>x');
		expect(html).toContain('consent@example.com');
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
	});

	it('refuses a consent form posted from another browser', async () => {
		const { jar } = await signedInUser('forge@example.com');
		const html = await (await jar.fetch(await authorizeUrl(await registerClient(), 'v'.repeat(50)))).text();
		const attacker = await signedInUser('attacker@example.com');
		const response = await attacker.jar.fetch('/authorize', {
			method: 'POST',
			body: new URLSearchParams({ handle: consentHandle(html), decision: 'approve' })
		});
		expect(response.status).toBe(400);
	});

	it('refuses consent once the session is gone', async () => {
		const { jar } = await signedInUser('gone@example.com');
		const html = await (await jar.fetch(await authorizeUrl(await registerClient(), 'v'.repeat(50)))).text();
		const response = await new Jar().fetch('/authorize', {
			method: 'POST',
			body: new URLSearchParams({ handle: consentHandle(html), decision: 'approve' })
		});
		expect(response.status).toBe(401);
	});

	it('sends access_denied back to the app on Deny', async () => {
		const { jar } = await signedInUser('deny@example.com');
		const html = await (await jar.fetch(await authorizeUrl(await registerClient(), 'v'.repeat(50)))).text();
		const response = await jar.fetch('/authorize', {
			method: 'POST',
			body: new URLSearchParams({ handle: consentHandle(html), decision: 'deny' })
		});
		const location = new URL(response.headers.get('Location')!);
		expect(location.searchParams.get('error')).toBe('access_denied');
		expect(location.searchParams.get('state')).toBe('client-state');
	});
});

describe('MCP', () => {
	it('acts as the signed-in user, in their own vault only', async () => {
		const alice = await connect((await signedInUser('alice@example.com')).jar);
		const bob = await connect((await signedInUser('bob@example.com')).jar);

		expect((await tool(alice, 'whoami')).text).toContain('<alice@example.com>');
		expect((await tool(alice, 'write_page', { path: 'notes/a.md', content: 'alice secret' })).isError).toBe(false);
		expect((await tool(alice, 'read_page', { path: 'notes/a.md' })).text).toContain('alice secret');

		expect((await tool(bob, 'whoami')).text).toContain('<bob@example.com>');
		expect((await tool(bob, 'read_page', { path: 'notes/a.md' })).isError).toBe(true);
		expect((await tool(bob, 'search', { query: 'secret' })).text).toBe('No matches.');
	});

	it('records the app in page history, and moves whole folders', async () => {
		const { user, jar } = await signedInUser('history@example.com');
		const token = await connect(jar);
		await tool(token, 'write_page', { path: 'old/a.md', content: 'one' });
		await tool(token, 'edit_page', { path: 'old/a.md', old_string: 'one', new_string: 'two' });
		expect((await tool(token, 'move_page', { from: 'old/', to: 'new' })).isError).toBe(true);
		expect((await tool(token, 'move_page', { from: 'old/', to: 'new/' })).text).toBe('Moved 1 page to new/');
		const history = await env.VAULT.getByName(user.id).history('new/a.md');
		expect(history.map((h) => [h.action, h.user, h.source])).toEqual([
			['move', user.id, 'Test client'],
			['edit', user.id, 'Test client'],
			['create', user.id, 'Test client']
		]);
	});

	it('turns vault failures into readable tool errors', async () => {
		const token = await connect((await signedInUser('errors@example.com')).jar);
		const result = await tool(token, 'write_page', { path: '../escape.md', content: 'x' });
		expect(result).toEqual({ isError: true, text: expect.stringContaining('".."') });
	});
});

describe('Account entrypoint', () => {
	it('lists and revokes connected apps, and the token stops working', async () => {
		const { user, jar } = await signedInUser('apps@example.com');
		const token = await connect(jar);
		const connections = await exports.Account.connections(user.id);
		expect(connections).toHaveLength(1);
		expect(connections[0].clientName).toBe('Test client');

		await exports.Account.disconnect(user.id, connections[0].grantId);
		expect(await exports.Account.connections(user.id)).toHaveLength(0);
		const response = await call('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' });
		expect(response.status).toBe(401);
	});

	it("cannot revoke another user's app", async () => {
		const owner = await signedInUser('owner@example.com');
		await connect(owner.jar);
		const [grant] = await exports.Account.connections(owner.user.id);
		const other = await signedInUser('other@example.com');
		await exports.Account.disconnect(other.user.id, grant.grantId).catch(() => {});
		expect(await exports.Account.connections(owner.user.id)).toHaveLength(1);
	});

	it('deleting an account revokes apps and erases the vault', async () => {
		const { user, jar } = await signedInUser('delete@example.com');
		const token = await connect(jar);
		await tool(token, 'write_page', { path: 'a.md', content: 'gone soon' });
		expect((await exports.Account.exportPages(user.id)).map((p) => p.path).sort()).toEqual(['BRIAN.md', 'a.md']);

		await exports.Account.deleteAccount(user.id);
		expect(await exports.Account.connections(user.id)).toHaveLength(0);
		expect(await exports.Account.exportPages(user.id)).toEqual([]);
		expect(await env.VAULT.getByName(user.id).list('')).toEqual({ folders: [], files: [] });
	});
});
