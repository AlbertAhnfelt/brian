import { encodeFrame, decodeFrame } from '@brian/sync';
import { LIMITS, type BrianSummary, type Outcome } from '@brian/shared';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { connect, failure, signedInUser, tool } from './helpers';

const account = exports.Account;
const CAP = LIMITS.storageBytesPerUser;
const by = { user: 'u_1', source: 'Claude' };
let seq = 0;

async function person(name: string) {
	const username = `${name}${++seq}`;
	const { user, jar } = await signedInUser(`${username}@example.com`, username);
	return { user, token: await connect(jar), name: username };
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.value;
}

/** A vault whose owner's other brians already hold all but `room` bytes of the cap. */
async function vaultWithRoom(room: number, name = crypto.randomUUID()) {
	const vault = env.VAULT.getByName(name);
	await vault.setOthers(CAP - room);
	return vault;
}

describe('storage per user', () => {
	it('refuses writes that add data past the cap, and keeps nothing of them', async () => {
		const vault = await vaultWithRoom(5_000);
		await vault.write('small.md', 'hello', undefined, by);
		const message = await failure(vault.write('big.md', 'x'.repeat(10_000), undefined, by));
		expect(message).toMatch(/full/);
		expect(await vault.readPages(['big.md'])).toEqual([null]);
		const page = await vault.read('small.md');
		expect(await failure(vault.edit('small.md', 'hello', 'y'.repeat(10_000), false, by))).toMatch(/full/);
		expect((await vault.read('small.md')).etag).toBe(page.etag);
	});

	it('always lets a full Brian shrink pages and delete them', async () => {
		const vault = await vaultWithRoom(1_000_000);
		await vault.write('a.md', 'x'.repeat(200_000), undefined, by);
		await vault.setOthers(CAP); // Now full.
		expect(await failure(vault.write('b.md', 'more', undefined, by))).toMatch(/full/);
		await vault.edit('a.md', 'x'.repeat(200_000), 'short', false, by);
		await vault.delete('a.md', by);
		expect((await vault.list()).files).toEqual([]);
	});

	it("still lets Brian write its own templates and rules", async () => {
		const vault = await vaultWithRoom(0);
		await vault.write('BRIAN.md', 'rules');
		expect((await vault.read('BRIAN.md')).content).toBe('rules');
	});

	it('warns agents once storage is nearly full', async () => {
		const vault = await vaultWithRoom(CAP * (1 - LIMITS.storageWarnShare));
		expect((await vault.write('a.md', 'hello', undefined, by)).warning).toMatch(/has used .* of its 3 GB/);
		const roomy = await vaultWithRoom(CAP);
		expect((await roomy.write('a.md', 'hello', undefined, by)).warning).toBeUndefined();
	});

	it('answers sync with "full", so the device keeps the change for later', async () => {
		const vault = await vaultWithRoom(1_000);
		const doc = new Y.Doc();
		doc.getText('content').insert(0, 'x'.repeat(5_000));
		const sent: Uint8Array[] = [];
		const ws = {
			deserializeAttachment: () => ({ user: 'u_1', email: 'a@example.com', source: 'Obsidian', role: 'owner' }),
			send: (frame: ArrayBuffer | Uint8Array) => sent.push(new Uint8Array(frame)),
			close: () => undefined
		};
		await runInDurableObject(vault, (instance) => {
			const frame = encodeFrame({ t: 'create', ref: 1, id: `p_${crypto.randomUUID()}`, path: 'a.md' }, [Y.encodeStateAsUpdate(doc)]);
			instance.webSocketMessage(ws as unknown as WebSocket, frame.slice().buffer);
		});
		const reply = decodeFrame(sent[0].slice().buffer);
		expect(reply.header).toMatchObject({ t: 'error', code: 'full' });
		expect((await vault.list()).files).toEqual([]);
	});

	it("counts a user's personal brian and the shared brians they own together", async () => {
		const ann = await person('ann');
		const shared = value(await account.createBrian(ann.user.id, 'acme', 'private')) as BrianSummary;
		const personal = env.VAULT.getByName(ann.user.id);
		const brian = env.VAULT.getByName(shared.id);
		await personal.write('notes.md', 'x'.repeat(50_000), undefined, by);
		await brian.write('doc.md', 'y'.repeat(30_000), undefined, by);
		expect(await runDurableObjectAlarm(personal)).toBe(true);
		expect(await runDurableObjectAlarm(brian)).toBe(true);
		const rows = await env.DB.prepare('SELECT vault, owner, bytes FROM storage WHERE owner = ? ORDER BY bytes DESC').bind(ann.user.id).all<{ vault: string; owner: string; bytes: number }>();
		expect(rows.results.map((r) => r.vault)).toEqual([ann.user.id, shared.id]);
		const [own, other] = rows.results;
		expect(own.bytes).toBe(await personal.usedBytes());
		expect(other.bytes).toBe(await brian.usedBytes());
		// Each brian knows what the others hold.
		const others = (v: typeof personal) => runInDurableObject(v, (_, state) => state.storage.sql.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'others'`).one().value);
		expect(await others(brian)).toBe(own.bytes);
	});

	it('clears the oldest trash first while over the cap', async () => {
		const ann = await person('bea');
		const personal = env.VAULT.getByName(ann.user.id);
		await personal.write('old.md', 'o'.repeat(40_000), undefined, by);
		await personal.delete('old.md', by);
		await personal.write('new.md', 'n'.repeat(40_000), undefined, by);
		await personal.delete('new.md', by);
		await personal.write('kept.md', 'k', undefined, by);
		// A sibling brian puts the user 10 kB over the cap: clearing the oldest trashed page is enough.
		const own = await personal.usedBytes();
		await env.DB.prepare('INSERT INTO storage (vault, owner, bytes, updated_at) VALUES (?, ?, ?, 0)').bind('b_sibling', ann.user.id, CAP - own + 10_000).run();
		await runDurableObjectAlarm(personal);
		const trash = (await personal.exportAll()).filter((p) => p.path.startsWith('.trash/')).map((p) => p.path.split('/').pop());
		expect(trash).toEqual(['new.md']);
		expect((await personal.read('kept.md')).content).toBe('k');
	});

	it('tells agents through MCP when it is full, and when it is nearly full', async () => {
		const ann = await person('cy');
		await env.VAULT.getByName(ann.user.id).setOthers(CAP * LIMITS.storageWarnShare);
		const saved = await tool(ann.token, 'write_page', { path: 'a.md', content: 'hello' });
		expect(saved.text).toMatch(/Let the user know/);
		await env.VAULT.getByName(ann.user.id).setOthers(CAP);
		const refused = await tool(ann.token, 'write_page', { path: 'b.md', content: 'hello' });
		expect(refused.isError).toBe(true);
		expect(refused.text).toMatch(/Your Brian is full/);
	});
});

describe('owned brians', () => {
	it(`caps how many shared brians one user owns, counting the trash`, async () => {
		const ann = await person('dee');
		const made: BrianSummary[] = [];
		for (let i = 0; i < LIMITS.ownedBriansPerUser; i++) made.push(value(await account.createBrian(ann.user.id, `brian-${i}`, 'private')) as BrianSummary);
		const over = await account.createBrian(ann.user.id, 'one-more', 'private');
		expect(over.ok).toBe(false);
		value(await account.deleteBrian(ann.user.id, made[0].id));
		expect((await account.createBrian(ann.user.id, 'still-no', 'private')).ok).toBe(false);
	});
});
