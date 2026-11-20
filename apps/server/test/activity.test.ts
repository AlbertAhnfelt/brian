import type { ActivityEntry, BrianSummary, Outcome } from '@brian/shared';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { addMember, connect, signedInUser, tool } from './helpers';

const account = exports.Account;
let seq = 0;

async function person(name: string) {
	const username = `${name}${++seq}`;
	const { user, jar } = await signedInUser(`${username}@example.com`, username);
	return { user, token: await connect(jar), name: username, email: `${username}@example.com` };
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.value;
}

const brianOf = async (owner: { user: { id: string } }, name = 'acme') => value(await account.createBrian(owner.user.id, name, 'private')) as BrianSummary;

const entries = async (userId: string, filter = {}) => (await account.activity(userId, filter)).entries;
const find = (list: ActivityEntry[], action: string, path?: string) => list.find((e) => e.action === action && (path === undefined || e.path === path));

describe('the activity log', () => {
	it("shows a page change with who made it and with what, in the user's own brian", async () => {
		const ann = await person('ann');
		await tool(ann.token, 'write_page', { path: 'notes/a.md', content: 'hello' });
		const list = await entries(ann.user.id);
		expect(find(list, 'create', 'notes/a.md')).toMatchObject({ who: ann.name, you: true, app: 'Test client', brian: null, count: 1, undoable: true });
		// Brian's own writes (the rules in BRIAN.md) aren't listed.
		expect(list.some((e) => e.path === 'BRIAN.md')).toBe(false);
	});

	it("lets an editor undo another member's agent deleting a page, and not a viewer", async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const cy = await person('cy');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'editor'));
		value(await addMember(ann.user.id, brian.id, cy.name, 'viewer'));
		await tool(ann.token, 'write_page', { path: 'brian/acme/plan.md', content: 'the plan' });
		await tool(ann.token, 'delete_page', { path: 'brian/acme/plan.md' });

		const deleted = find(await entries(bo.user.id), 'delete', 'brian/acme/plan.md')!;
		expect(deleted).toMatchObject({ who: ann.name, you: false, brian: { id: brian.id, name: 'acme' }, undoable: true });
		const seen = find(await entries(cy.user.id), 'delete', 'brian/acme/plan.md')!;
		expect(seen.undoable).toBe(false);
		expect(await account.undo(cy.user.id, seen.key)).toMatchObject({ ok: false });

		expect(value(await account.undo(bo.user.id, deleted.key))).toBe('Restored 1 page.');
		expect((await tool(ann.token, 'read_page', { path: 'brian/acme/plan.md' })).text).toContain('the plan');
		expect(await account.undo(bo.user.id, deleted.key)).toMatchObject({ ok: false }); // Nothing left to undo.
		// The undo is logged too, as the website.
		expect(find(await entries(ann.user.id), 'restore', 'brian/acme/plan.md')).toMatchObject({ who: bo.name, app: 'website' });
	});

	it('shows a folder move as one entry, and undoes it', async () => {
		const ann = await person('ann');
		for (const n of [1, 2, 3]) await tool(ann.token, 'write_page', { path: `old/sub/p${n}.md`, content: `page ${n}` });
		await tool(ann.token, 'move_page', { from: 'old/', to: 'new/' });
		const moved = find(await entries(ann.user.id), 'move')!;
		expect(moved).toMatchObject({ count: 3, path: 'new/sub/', undoable: true });
		expect(value(await account.undo(ann.user.id, moved.key))).toBe('Moved back: 3 pages.');
		expect((await tool(ann.token, 'read_page', { path: 'old/sub/p2.md' })).text).toContain('page 2');
	});

	it("can't undo an edit, and says why", async () => {
		const ann = await person('ann');
		await tool(ann.token, 'write_page', { path: 'a.md', content: 'one' });
		await tool(ann.token, 'edit_page', { path: 'a.md', old_string: 'one', new_string: 'two' });
		const edit = find(await entries(ann.user.id), 'edit')!;
		expect(edit.undoable).toBe(false);
		expect(await account.undo(ann.user.id, edit.key)).toMatchObject({ ok: false, message: expect.stringContaining("earlier text") });
	});

	it('records changes to a brian, and shows invitations to its owner only', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'viewer'));
		value(await account.invite(ann.user.id, brian.id, 'someone@example.org', 'editor'));
		value(await account.setRole(ann.user.id, brian.id, bo.name, 'editor'));

		const mine = await entries(ann.user.id, { brian: brian.id });
		expect(mine.map((e) => e.action)).toEqual(['brian.role', 'brian.invite', 'brian.accept', 'brian.invite', 'brian.create']);
		expect(find(mine, 'brian.role')).toMatchObject({ target: bo.name, role: 'editor', from: 'viewer', app: 'website', undoable: true });
		const theirs = await entries(bo.user.id, { brian: brian.id });
		expect(theirs.map((e) => e.action)).toEqual(['brian.role', 'brian.accept', 'brian.create']);
		expect(theirs.every((e) => !e.undoable)).toBe(true);

		// Undo the role change, then the email invitation.
		expect(value(await account.undo(ann.user.id, find(mine, 'brian.role')!.key))).toContain('a viewer again');
		expect(await account.brians(bo.user.id)).toMatchObject([{ role: 'viewer' }]);
		const emailed = mine.find((e) => e.action === 'brian.invite' && e.target === 'someone@example.org')!;
		value(await account.undo(ann.user.id, emailed.key));
		const view = await account.viewBrian(ann.user.id, brian.id);
		expect(view?.member && view.invites).toEqual([]);
	});

	it('invites a removed member back rather than putting them back', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'editor'));
		value(await account.removeMember(ann.user.id, brian.id, bo.name));
		const removed = find(await entries(ann.user.id), 'brian.remove')!;
		expect(value(await account.undo(ann.user.id, removed.key))).toContain('once they accept');
		expect(await account.brians(bo.user.id)).toEqual([]);
		expect(await account.invites(bo.user.id)).toMatchObject([{ brianId: brian.id, role: 'editor' }]);
	});

	it('shows a deleted brian to its members, and lets the owner undo it', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'viewer'));
		value(await account.deleteBrian(ann.user.id, brian.id));
		expect(find(await entries(bo.user.id), 'brian.delete')).toMatchObject({ who: ann.name, undoable: false });
		const deleted = find(await entries(ann.user.id), 'brian.delete')!;
		expect(deleted.undoable).toBe(true);
		expect(await account.undo(bo.user.id, deleted.key)).toMatchObject({ ok: false });
		value(await account.undo(ann.user.id, deleted.key));
		expect(await account.brians(bo.user.id)).toMatchObject([{ id: brian.id }]);
	});

	it('logs what agents do to brians with the app they used', async () => {
		const ann = await person('ann');
		await tool(ann.token, 'create_brian', { name: 'thesis' });
		expect(find(await entries(ann.user.id), 'brian.create')).toMatchObject({ app: 'Test client', target: 'thesis' });
	});

	it('filters by brian, person and app, and pages through older entries', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = await brianOf(ann);
		value(await addMember(ann.user.id, brian.id, bo.name, 'editor'));
		await tool(bo.token, 'write_page', { path: 'brian/acme/bo.md', content: 'x' });
		await tool(ann.token, 'write_page', { path: 'mine.md', content: 'x' });

		expect((await entries(ann.user.id, { brian: 'personal' })).every((e) => e.brian === null)).toBe(true);
		expect((await entries(ann.user.id, { person: bo.name })).map((e) => e.action)).toEqual(['create', 'brian.accept']);
		expect((await entries(ann.user.id, { app: 'website' })).every((e) => e.app === 'website')).toBe(true);
		expect(await entries(ann.user.id, { person: 'nobody-at-all' })).toEqual([]);

		for (let n = 0; n < 55; n++) await tool(ann.token, 'write_page', { path: `many/p${n}.md`, content: 'x' });
		const first = await account.activity(ann.user.id, { brian: 'personal' });
		expect(first.entries.length).toBeGreaterThanOrEqual(50);
		expect(first.before).not.toBeNull();
		const second = await account.activity(ann.user.id, { brian: 'personal', before: first.before! });
		const keys = new Set(first.entries.map((e) => e.key));
		expect(second.entries.length).toBeGreaterThan(0);
		expect(second.entries.some((e) => keys.has(e.key))).toBe(false);
		expect(first.entries.length + second.entries.length).toBe(56); // 55, and mine.md.
	});
});
