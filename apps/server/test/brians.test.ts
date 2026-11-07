import type { BrianSummary, Outcome } from '@brian/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, connect, signedInUser, tool } from './helpers';

const account = exports.Account;

let seq = 0;

/** A signed-in user with an MCP token and a unique username starting with `name` (D1 is shared per file). */
async function person(name: string) {
	const username = `${name}${++seq}`;
	const { user, jar } = await signedInUser(`${username}@example.com`, username);
	return { user, token: await connect(jar), name: username };
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.value;
}

async function brianOf(owner: { user: { id: string } }, name = 'acme', visibility: 'private' | 'public' = 'private') {
	return value(await account.createBrian(owner.user.id, name, visibility)) as BrianSummary;
}

async function initialize(token: string): Promise<string> {
	const response = await call('/mcp', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
		})
	});
	const body = await response.text();
	const json = JSON.parse(body.startsWith('{') ? body : /^data: (.*)$/m.exec(body)![1]);
	return json.result.instructions as string;
}

describe('creating a brian', () => {
	it('mounts it for the owner at brian/<name>/, with a marked BRIAN.md', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		expect(brian).toMatchObject({ name: 'acme', role: 'owner', mount: 'acme', visibility: 'private' });
		expect(brian.id).toMatch(/^b_/);

		const md = await tool(ann.token, 'read_page', { path: 'brian/acme/BRIAN.md' });
		expect(md.text).toContain(`brian: ${brian.id}`);
		expect((await tool(ann.token, 'list', { prefix: '' })).text).toContain('brian/');
		expect((await tool(ann.token, 'list', { prefix: 'brian/' })).text).toContain('brian/acme/');
		expect((await tool(ann.token, 'list', { prefix: 'brian/acme' })).text).toBe('brian/acme/BRIAN.md');
	});

	it('stores pages relative to the brian, apart from the personal brian', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'the plan' });
		expect((await env.VAULT.getByName(brian.id).read('plan.md')).content).toBe('the plan');
		expect(await env.VAULT.getByName(ann.user.id).list('')).toEqual({ folders: [], files: [] });
	});

	it('refuses bad names', async () => {
		const ann = await person('ann');
		expect(await account.createBrian(ann.user.id, 'Not ok!', 'private')).toMatchObject({ ok: false });
	});
});

describe('roles', () => {
	it("editors' changes reach every member", async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await account.addMember(ann.user.id, brian.id, bo.name, 'editor'));

		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'v1' });
		const read = await tool(bo.token, 'read_page', { path: 'brian/acme/plan.md' });
		expect(read.text).toContain('v1');
		await tool(bo.token, 'edit_page', { path: 'brian/acme/plan.md', old_string: 'v1', new_string: 'v2' });
		expect((await tool(ann.token, 'read_page', { path: 'brian/acme/plan.md' })).text).toContain('v2');
	});

	it('viewers read but never write', async () => {
		const ann = await person('ann');
		const cy = await person('cy');
		const brian = await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'v1' });
		value(await account.addMember(ann.user.id, brian.id, cy.name, 'viewer'));

		expect((await tool(cy.token, 'read_page', { path: 'brian/acme/plan.md' })).text).toContain('v1');
		for (const [name, args] of [
			['write_page', { path: 'brian/acme/new.md', content: 'x' }],
			['edit_page', { path: 'brian/acme/plan.md', old_string: 'v1', new_string: 'v2' }],
			['delete_page', { path: 'brian/acme/plan.md' }],
			['move_page', { from: 'brian/acme/plan.md', to: 'mine.md' }]
		] as const) {
			const result = await tool(cy.token, name, args);
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(new RegExp(`read-only.*brian/${cy.name}/`));
		}
		expect((await tool(ann.token, 'read_page', { path: 'brian/acme/plan.md' })).text).toContain('v1');
	});

	it('only the owner manages members, and there is one owner', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const cy = await person('cy');
		const brian = await brianOf(ann);
		value(await account.addMember(ann.user.id, brian.id, bo.name, 'editor'));

		expect(await account.addMember(bo.user.id, brian.id, cy.name, 'editor')).toMatchObject({ ok: false });
		expect(await account.setVisibility(bo.user.id, brian.id, 'public')).toMatchObject({ ok: false });
		expect(await account.deleteBrian(bo.user.id, brian.id)).toMatchObject({ ok: false });
		expect(await account.removeMember(bo.user.id, brian.id, ann.name)).toMatchObject({ ok: false });
		expect(await account.addMember(ann.user.id, brian.id, cy.name, 'owner' as 'editor')).toMatchObject({ ok: false });
		expect(await account.setRole(ann.user.id, brian.id, ann.name, 'viewer')).toMatchObject({ ok: false });
		expect(await account.addMember(ann.user.id, brian.id, bo.name, 'viewer')).toMatchObject({ ok: false });
		expect(await account.addMember(ann.user.id, brian.id, 'nobody', 'viewer')).toMatchObject({ ok: false });
	});

	it('a changed role or removal applies from the next call', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await account.addMember(ann.user.id, brian.id, bo.name, 'editor'));
		expect((await tool(bo.token, 'write_page', { path: 'brian/acme/a.md', content: 'x' })).isError).toBe(false);

		value(await account.setRole(ann.user.id, brian.id, bo.name, 'viewer'));
		expect((await tool(bo.token, 'write_page', { path: 'brian/acme/b.md', content: 'x' })).isError).toBe(true);

		value(await account.removeMember(ann.user.id, brian.id, bo.name));
		// Now brian/acme/ is just a folder name in bo's personal brian.
		expect((await tool(bo.token, 'read_page', { path: 'brian/acme/a.md' })).isError).toBe(true);
		expect((await tool(bo.token, 'search', { query: 'BRIAN' })).text).toBe('No matches.');
	});

	it('members leave; owners delete instead', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await account.addMember(ann.user.id, brian.id, bo.name, 'viewer'));
		expect(await account.leave(ann.user.id, brian.id)).toMatchObject({ ok: false });
		value(await account.leave(bo.user.id, brian.id));
		expect(await account.brians(bo.user.id)).toEqual([]);
	});
});

describe('visibility', () => {
	it('a private brian is invisible to strangers', async () => {
		const ann = await person('ann');
		const eve = await person('eve');
		const brian = await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'brian/acme/secret.md', content: 'secret' });

		expect(await account.viewBrian(eve.user.id, brian.id)).toBeNull();
		expect(await account.join(eve.user.id, brian.id)).toMatchObject({ ok: false });
		expect((await tool(eve.token, 'read_page', { path: 'brian/acme/secret.md' })).isError).toBe(true);
		expect((await tool(eve.token, 'search', { query: 'secret' })).text).toBe('No matches.');
	});

	it('anyone can join a public brian, as a viewer', async () => {
		const ann = await person('ann');
		const eve = await person('eve');
		const brian = await brianOf(ann, 'course', 'public');
		await tool(ann.token, 'write_page', { path: 'brian/course/week1.md', content: 'lecture one' });

		expect(await account.viewBrian(eve.user.id, brian.id)).toEqual({
			member: false,
			brian: { id: brian.id, name: 'course', visibility: 'public' }
		});
		expect(value(await account.join(eve.user.id, brian.id))).toMatchObject({ role: 'viewer', mount: 'course' });
		expect(value(await account.join(eve.user.id, brian.id))).toMatchObject({ role: 'viewer' });
		expect((await tool(eve.token, 'read_page', { path: 'brian/course/week1.md' })).text).toContain('lecture one');
		expect((await tool(eve.token, 'write_page', { path: 'brian/course/x.md', content: 'x' })).isError).toBe(true);

		const view = await account.viewBrian(eve.user.id, brian.id);
		expect(view).toMatchObject({ member: true, members: [{ username: ann.name, role: 'owner' }, { username: eve.name, role: 'viewer' }] });
	});

	it('making a brian private stops new joins but keeps members', async () => {
		const ann = await person('ann');
		const eve = await person('eve');
		const fay = await person('fay');
		const brian = await brianOf(ann, 'course', 'public');
		value(await account.join(eve.user.id, brian.id));
		value(await account.setVisibility(ann.user.id, brian.id, 'private'));
		expect(await account.join(fay.user.id, brian.id)).toMatchObject({ ok: false });
		expect(await account.brians(eve.user.id)).toHaveLength(1);
	});
});

describe('folder names', () => {
	it("never shadows the member's own pages or agent folder", async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		await tool(bo.token, 'write_page', { path: 'brian/acme/mine.md', content: 'bo wrote this' });
		const acme = await brianOf(ann);
		const named = await brianOf(ann, bo.name);
		value(await account.addMember(ann.user.id, acme.id, bo.name, 'editor'));
		value(await account.addMember(ann.user.id, named.id, bo.name, 'editor'));

		const mounts = (await account.brians(bo.user.id)).map((b) => [b.name, b.mount]);
		expect(mounts).toEqual([
			['acme', 'acme-2'],
			[bo.name, `${bo.name}-2`]
		]);
		expect((await tool(bo.token, 'read_page', { path: 'brian/acme/mine.md' })).text).toContain('bo wrote this');
		expect((await tool(bo.token, 'read_page', { path: 'brian/acme-2/BRIAN.md' })).text).toContain(acme.id);
	});
});

describe('one Brian across brians', () => {
	it('searches every brian, with paths as the user sees them', async () => {
		const ann = await person('ann');
		await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'notes/zebra.md', content: 'zebra notes' });
		await tool(ann.token, 'write_page', { path: 'brian/acme/zebra.md', content: 'zebra plan' });
		const hits = (await tool(ann.token, 'search', { query: 'zebra' })).text;
		expect(hits).toContain('notes/zebra.md');
		expect(hits).toContain('brian/acme/zebra.md');
	});

	it('moves pages between brians', async () => {
		const ann = await person('ann');
		await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'draft.md', content: 'ready to share' });
		expect((await tool(ann.token, 'move_page', { from: 'draft.md', to: 'brian/acme/shared.md' })).text).toBe(
			'Moved to brian/acme/shared.md'
		);
		expect((await tool(ann.token, 'read_page', { path: 'draft.md' })).isError).toBe(true);
		expect((await tool(ann.token, 'read_page', { path: 'brian/acme/shared.md' })).text).toContain('ready to share');
	});

	it("explains the layout to agents in the server's instructions", async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await account.addMember(ann.user.id, brian.id, bo.name, 'viewer'));
		const text = await initialize(bo.token);
		expect(text).toContain(`This is ${bo.name}'s Brian`);
		expect(text).toContain(`brian/${bo.name}/ is yours to write in freely`);
		expect(text).toContain('brian/acme/ — "acme", viewer (read-only), private');
	});

	it('exports shared brians under brian/<mount>/', async () => {
		const ann = await person('ann');
		await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'a.md', content: 'mine' });
		const paths = (await account.exportPages(ann.user.id)).map((p) => p.path).sort();
		expect(paths).toEqual(['a.md', 'brian/acme/BRIAN.md']);
	});

	it('asks for a username before anything else', async () => {
		const ann = await person('ann');
		await env.DB.prepare('UPDATE users SET username = NULL WHERE id = ?').bind(ann.user.id).run();
		const result = await tool(ann.token, 'list', { prefix: '' });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/pick a username at .*\/welcome/);
	});
});

describe('deleting', () => {
	it('deleting a brian erases it for every member', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await account.addMember(ann.user.id, brian.id, bo.name, 'editor'));
		value(await account.deleteBrian(ann.user.id, brian.id));
		expect(await account.brians(bo.user.id)).toEqual([]);
		expect(await env.VAULT.getByName(brian.id).list('')).toEqual({ folders: [], files: [] });
	});

	it("deleting an account erases the brians it owns and leaves the others", async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const annOwns = await brianOf(ann, 'anns');
		const boOwns = await brianOf(bo, 'bos');
		value(await account.addMember(ann.user.id, annOwns.id, bo.name, 'editor'));
		value(await account.addMember(bo.user.id, boOwns.id, ann.name, 'editor'));

		await account.deleteAccount(ann.user.id);
		expect((await account.brians(bo.user.id)).map((b) => b.name)).toEqual(['bos']);
		expect(await env.VAULT.getByName(annOwns.id).list('')).toEqual({ folders: [], files: [] });
		const view = await account.viewBrian(bo.user.id, boOwns.id);
		expect(view).toMatchObject({ members: [{ username: bo.name, role: 'owner' }] });
	});
});
