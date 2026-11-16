import { linkLogin, LIMITS, type BrianSummary, type Outcome } from '@brian/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { purgeDeletedBrians, setMount } from '../src/brian/members';
import { addMember, call, connect, signedInUser, tool } from './helpers';

const account = exports.Account;
let seq = 0;

async function person(name: string) {
	const username = `${name}${++seq}`;
	const email = `${username}@example.com`;
	const { user, jar } = await signedInUser(email, username);
	return { user, token: await connect(jar), name: username, email };
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.value;
}

const brianOf = async (owner: { user: { id: string } }, name = 'acme', visibility: 'private' | 'public' = 'private') =>
	value(await account.createBrian(owner.user.id, name, visibility)) as BrianSummary;

async function instructions(token: string): Promise<string> {
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
	return JSON.parse(body.startsWith('{') ? body : /^data: (.*)$/m.exec(body)![1]).result.instructions;
}

const DAY = 24 * 60 * 60;

describe('the trash for brians', () => {
	it('restores a deleted brian with its members, their folders and its pages', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'viewer'));
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'the plan' });
		value(await setMount(env, bo.user.id, brian.id, 'anns-acme'));
		value(await account.deleteBrian(ann.user.id, brian.id));

		// Only the owner restores.
		expect(await account.restoreBrian(bo.user.id, brian.id)).toMatchObject({ ok: false });
		expect(value(await account.restoreBrian(ann.user.id, brian.id))).toMatchObject({ id: brian.id, role: 'owner', mount: 'acme' });
		expect(await account.deletedBrians(ann.user.id)).toEqual([]);
		expect(await account.brians(bo.user.id)).toMatchObject([{ id: brian.id, role: 'viewer', mount: 'anns-acme' }]);
		expect((await tool(bo.token, 'read_page', { path: 'brian/anns-acme/plan.md' })).text).toContain('the plan');
		expect(await account.restoreBrian(ann.user.id, brian.id)).toMatchObject({ ok: false }); // Not in the trash any more.
	});

	it('frees folder names meanwhile, and restores beside a new brian of the same name', async () => {
		const ann = await person('ann');
		const old = await brianOf(ann);
		value(await account.deleteBrian(ann.user.id, old.id));
		const fresh = await brianOf(ann);
		expect(fresh.mount).toBe('acme');
		expect(value(await account.restoreBrian(ann.user.id, old.id)).mount).toBe('acme-2');
	});

	it('hides a deleted public brian from strangers, and drops its open invitations', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const cy = await person('cy');
		const brian = await brianOf(ann, 'open', 'public');
		value(await account.invite(ann.user.id, brian.id, bo.name, 'editor'));
		value(await account.invite(ann.user.id, brian.id, 'later@example.com', 'editor'));
		value(await account.deleteBrian(ann.user.id, brian.id));
		expect(await account.viewBrian(cy.user.id, brian.id)).toBeNull();
		expect(await account.join(cy.user.id, brian.id)).toMatchObject({ ok: false });
		expect(await account.invites(bo.user.id)).toEqual([]);
		value(await account.restoreBrian(ann.user.id, brian.id));
		expect(await account.viewBrian(ann.user.id, brian.id)).toMatchObject({ invites: [] });
	});

	it(`is purged after ${LIMITS.trashDays} days, not before`, async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'editor'));
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'the plan' });
		value(await account.deleteBrian(ann.user.id, brian.id));
		const now = Math.floor(Date.now() / 1000);

		await purgeDeletedBrians(env, now + (LIMITS.trashDays - 1) * DAY);
		expect(await account.deletedBrians(ann.user.id)).toHaveLength(1);

		expect(await purgeDeletedBrians(env, now + LIMITS.trashDays * DAY + 60)).toBeGreaterThanOrEqual(1);
		expect(await env.DB.prepare('SELECT 1 FROM brians WHERE id = ?').bind(brian.id).first()).toBeNull();
		expect(await env.DB.prepare('SELECT 1 FROM deleted_members WHERE brian_id = ?').bind(brian.id).first()).toBeNull();
		expect(await env.VAULT.getByName(brian.id).list('')).toEqual({ folders: [], files: [] });
	});

	it('retries a purge that stopped halfway, and never purges a live brian', async () => {
		const ann = await person('ann');
		const stuck = await brianOf(ann, 'stuck');
		const live = await brianOf(ann, 'live');
		await tool(ann.token, 'write_page', { path: 'brian/stuck/a.md', content: 'a' });
		value(await account.deleteBrian(ann.user.id, stuck.id));
		// As left by a purge whose erase failed: marked, rows still there.
		await env.DB.prepare('UPDATE brians SET deleted_at = 1 WHERE id = ?').bind(stuck.id).run();
		expect(await account.deletedBrians(ann.user.id)).toEqual([]);
		expect(await account.restoreBrian(ann.user.id, stuck.id)).toMatchObject({ ok: false });
		await purgeDeletedBrians(env);
		expect(await env.DB.prepare('SELECT 1 FROM brians WHERE id = ?').bind(stuck.id).first()).toBeNull();
		expect(await env.VAULT.getByName(stuck.id).list('')).toEqual({ folders: [], files: [] });
		await purgeDeletedBrians(env, Math.floor(Date.now() / 1000) + 365 * DAY);
		expect(await account.brians(ann.user.id)).toMatchObject([{ id: live.id }]);
	});

	it('goes with the account of its owner', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'the plan' });
		value(await account.deleteBrian(ann.user.id, brian.id));
		await account.deleteAccount(ann.user.id);
		expect(await env.DB.prepare('SELECT 1 FROM brians WHERE id = ?').bind(brian.id).first()).toBeNull();
		expect(await env.VAULT.getByName(brian.id).list('')).toEqual({ folders: [], files: [] });
	});
});

describe('invitations by email', () => {
	it('wait for an address nobody uses yet, then reach whoever signs in with it', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'the plan' });
		expect(value(await account.invite(ann.user.id, brian.id, '  New.Person@Example.com ', 'editor'))).toBe('email');
		expect(await account.invite(ann.user.id, brian.id, 'new.person@example.com', 'viewer')).toMatchObject({ ok: false }); // Twice.
		expect(await account.viewBrian(ann.user.id, brian.id)).toMatchObject({ invites: [{ who: 'new.person@example.com', role: 'editor' }] });

		const { user } = await signedInUser('new.person@example.com', `newbie${++seq}`);
		expect(await account.invites(user.id)).toMatchObject([{ brianId: brian.id, role: 'editor', from: ann.name }]);
		expect(value(await account.acceptInvite(user.id, brian.id))).toMatchObject({ role: 'editor', mount: 'acme' });
		expect(await account.viewBrian(ann.user.id, brian.id)).toMatchObject({ invites: [] });
		expect(await env.DB.prepare('SELECT 1 FROM email_invites WHERE brian_id = ?').bind(brian.id).first()).toBeNull();
	});

	it('go straight to the account of an address in use, on any of its logins', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		await linkLogin(env.DB, bo.user.id, { provider: 'google', providerUserId: `g-${bo.name}`, email: `${bo.name}@work.example`, name: null });
		const brian = await brianOf(ann);
		expect(value(await account.invite(ann.user.id, brian.id, bo.email.toUpperCase(), 'viewer'))).toBe('account');
		value(await account.cancelInvite(ann.user.id, brian.id, bo.email));
		expect(await account.invites(bo.user.id)).toEqual([]);
		expect(value(await account.invite(ann.user.id, brian.id, `${bo.name}@work.example`, 'viewer'))).toBe('account');
		expect(await account.viewBrian(ann.user.id, brian.id)).toMatchObject({ invites: [{ who: bo.name }] });
		expect(await account.invite(ann.user.id, brian.id, ann.email, 'viewer')).toMatchObject({ ok: false, message: "That's you." });
	});

	it('are claimed by a login added later, and can be cancelled before that', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await account.invite(ann.user.id, brian.id, 'cancel-me@example.com', 'viewer'));
		value(await account.cancelInvite(ann.user.id, brian.id, 'Cancel-Me@example.com'));
		expect(await account.viewBrian(ann.user.id, brian.id)).toMatchObject({ invites: [] });

		value(await account.invite(ann.user.id, brian.id, `${bo.name}@later.example`, 'viewer'));
		expect(await account.invites(bo.user.id)).toEqual([]);
		await linkLogin(env.DB, bo.user.id, { provider: 'apple', providerUserId: `a-${bo.name}`, email: `${bo.name}@later.example`, name: null });
		expect(await account.invites(bo.user.id)).toMatchObject([{ brianId: brian.id, role: 'viewer' }]);
		value(await account.declineInvite(bo.user.id, brian.id));
		expect(await account.invites(bo.user.id)).toEqual([]);
	});

	it("show the address typed, and don't tell apart an account without a username", async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		const { user } = await signedInUser(`main${++seq}@example.com`, null);
		await linkLogin(env.DB, user.id, { provider: 'google', providerUserId: `g-${seq}`, email: `typed${seq}@example.com`, name: null });
		expect(value(await account.invite(ann.user.id, brian.id, `typed${seq}@example.com`, 'viewer'))).toBe('email');
		expect(await account.viewBrian(ann.user.id, brian.id)).toMatchObject({ invites: [{ who: `typed${seq}@example.com` }] });
		expect(await account.invites(user.id)).toMatchObject([{ brianId: brian.id }]);
		value(await account.cancelInvite(ann.user.id, brian.id, `typed${seq}@example.com`));
		expect(await account.invites(user.id)).toEqual([]);
	});

	it('are capped per brian', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		for (let i = 0; i < LIMITS.openInvitesPerBrian; i++) value(await account.invite(ann.user.id, brian.id, `p${i}@cap.example`, 'viewer'));
		expect(await account.invite(ann.user.id, brian.id, 'one-more@cap.example', 'viewer')).toMatchObject({ ok: false, message: expect.stringContaining('at most') });
		value(await account.cancelInvite(ann.user.id, brian.id, 'p0@cap.example'));
		value(await account.invite(ann.user.id, brian.id, 'one-more@cap.example', 'viewer'));
	});

	it('refuse what isn\'t an email address', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		for (const bad of ['@example.com', 'a@b', 'two words@example.com', `${'x'.repeat(250)}@example.com`]) {
			expect(await account.invite(ann.user.id, brian.id, bad, 'viewer')).toMatchObject({ ok: false });
		}
	});
});

describe('agents managing brians', () => {
	it('create, share, rename, publish, delete and restore a brian, like the website', async () => {
		const ann = await person('ann');
		const bo = await person('bo');

		const created = await tool(ann.token, 'create_brian', { name: 'Thesis' });
		expect(created).toMatchObject({ isError: false, text: expect.stringContaining('brian/thesis/') });
		const [brian] = await account.brians(ann.user.id);
		expect(brian).toMatchObject({ name: 'thesis', role: 'owner', visibility: 'private' });
		expect((await tool(ann.token, 'read_page', { path: 'brian/thesis/BRIAN.md' })).text).toContain(brian.id);

		expect((await tool(ann.token, 'share_brian', { brian: 'brian/thesis/', who: bo.name })).text).toContain('Invited');
		expect((await tool(ann.token, 'share_brian', { brian: 'thesis', who: 'prof@uni.example', role: 'viewer' })).text).toContain("doesn't send an email");
		const info = await tool(ann.token, 'brian_info', { brian: brian.id });
		expect(info.text).toContain(`${ann.name} (owner)`);
		expect(info.text).toContain(`${bo.name} (editor)`);
		expect(info.text).toContain('prof@uni.example (viewer)');

		// Bo's agent sees the invitation and accepts it.
		expect((await tool(bo.token, 'whoami')).text).toContain(`"thesis" from ${ann.name}, as editor`);
		expect((await tool(bo.token, 'answer_invite', { brian: 'thesis', accept: true })).text).toContain('brian/thesis/');
		expect((await tool(bo.token, 'write_page', { path: 'brian/thesis/ch1.md', content: 'chapter one' })).isError).toBe(false);

		expect((await tool(ann.token, 'set_member', { brian: 'thesis', who: bo.name, role: 'viewer' })).text).toContain('now a viewer');
		expect((await tool(bo.token, 'write_page', { path: 'brian/thesis/ch2.md', content: 'x' })).isError).toBe(true);
		expect((await tool(ann.token, 'set_member', { brian: 'thesis', who: 'prof@uni.example', role: 'editor' })).text).toContain('invited as an editor');
		expect((await tool(ann.token, 'set_member', { brian: 'thesis', who: 'prof@uni.example', role: 'remove' })).text).toContain('Took back');

		expect((await tool(ann.token, 'update_brian', { brian: 'thesis', visibility: 'public', folder: 'paper' })).text).toContain('brian/paper/');
		expect(await account.brians(ann.user.id)).toMatchObject([{ name: 'paper', mount: 'paper', visibility: 'public' }]);
		expect(await account.brians(bo.user.id)).toMatchObject([{ mount: 'thesis' }]); // Bo's folder keeps its name.

		const wrong = await tool(ann.token, 'delete_brian', { brian: 'paper', confirm: 'thesis' });
		expect(wrong).toMatchObject({ isError: true, text: expect.stringContaining('"paper"') });
		expect((await tool(bo.token, 'delete_brian', { brian: 'thesis', confirm: 'paper' })).isError).toBe(true); // Not bo's.
		expect((await tool(ann.token, 'delete_brian', { brian: 'paper', confirm: 'paper' })).text).toContain('trash');
		expect(await account.brians(bo.user.id)).toEqual([]);
		expect((await tool(ann.token, 'whoami')).text).toContain('In the trash');
		expect((await tool(ann.token, 'restore_brian', { brian: 'paper' })).text).toContain('Restored');
		expect((await tool(bo.token, 'read_page', { path: 'brian/thesis/ch1.md' })).text).toContain('chapter one');

		expect((await tool(bo.token, 'leave_brian', { brian: 'thesis' })).isError).toBe(false);
		expect(await account.brians(bo.user.id)).toEqual([]);
		expect((await tool(ann.token, 'leave_brian', { brian: 'paper' })).isError).toBe(true); // Owners delete instead.
	});

	it('join public brians from a link, decline invitations and manage friends', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const open = await brianOf(ann, 'course', 'public');
		const closed = await brianOf(ann, 'secret');

		expect((await tool(bo.token, 'join_brian', { link: `https://mybrian.dev/b/${open.id}` })).text).toContain('brian/course/');
		expect((await tool(bo.token, 'join_brian', { link: closed.id })).isError).toBe(true);
		expect((await tool(bo.token, 'join_brian', { link: 'nonsense' })).isError).toBe(true);

		value(await account.invite(ann.user.id, closed.id, bo.name, 'viewer'));
		expect((await tool(bo.token, 'answer_invite', { brian: closed.id, accept: false })).text).toContain('Declined');
		expect((await tool(bo.token, 'answer_invite', { brian: 'secret', accept: true })).isError).toBe(true);

		expect((await tool(bo.token, 'friends', { action: 'find', who: ann.email })).text).toBe(ann.name);
		expect((await tool(bo.token, 'friends', { action: 'add', who: ann.name })).isError).toBe(false);
		expect((await tool(bo.token, 'friends', { action: 'list' })).text).toBe(ann.name);
		expect((await tool(bo.token, 'friends', { action: 'remove', who: ann.name })).isError).toBe(false);
		expect((await tool(bo.token, 'friends', { action: 'list' })).text).toBe('No friends added yet.');
	});

	it('only do what the user may: owners manage members, and a missing brian is named', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const cy = await person('cy');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'editor'));
		expect((await tool(bo.token, 'share_brian', { brian: 'acme', who: cy.name })).isError).toBe(true);
		expect((await tool(bo.token, 'set_member', { brian: 'acme', who: ann.name, role: 'remove' })).isError).toBe(true);
		expect((await tool(bo.token, 'update_brian', { brian: 'acme', visibility: 'public' })).isError).toBe(true);
		const missing = await tool(bo.token, 'brian_info', { brian: 'nope' });
		expect(missing).toMatchObject({ isError: true, text: expect.stringContaining('brian/acme/') });
		expect((await tool(cy.token, 'brian_info', { brian: brian.id })).isError).toBe(true);
	});

	it('stop at the switch on /account, while reading and pages keep working', async () => {
		const ann = await person('ann');
		const brian = await brianOf(ann);
		expect(await instructions(ann.token)).toContain('create_brian makes a new shared brian');
		expect(await account.agentsManageBrians(ann.user.id)).toBe(true);

		await account.setAgentsManageBrians(ann.user.id, false);
		expect(await account.agentsManageBrians(ann.user.id)).toBe(false);
		expect(await instructions(ann.token)).toContain('Managing brians is turned off for agents');
		for (const [name, args] of [
			['create_brian', { name: 'nope' }],
			['share_brian', { brian: 'acme', who: 'x@example.com' }],
			['delete_brian', { brian: 'acme', confirm: 'acme' }],
			['update_brian', { brian: 'acme', visibility: 'public' }],
			['friends', { action: 'add', who: 'someone' }]
		] as const) {
			expect(await tool(ann.token, name, args)).toMatchObject({ isError: true, text: expect.stringContaining('/account') });
		}
		expect(await account.brians(ann.user.id)).toMatchObject([{ id: brian.id, visibility: 'private' }]);
		expect((await tool(ann.token, 'brian_info', { brian: 'acme' })).isError).toBe(false);
		expect((await tool(ann.token, 'write_page', { path: 'brian/acme/a.md', content: 'still fine' })).isError).toBe(false);

		await account.setAgentsManageBrians(ann.user.id, true);
		expect((await tool(ann.token, 'create_brian', { name: 'yes' })).isError).toBe(false);
	});
});
