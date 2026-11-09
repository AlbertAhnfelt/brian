import type { BrianSummary, Outcome } from '@brian/shared';
import { decodeFrame, encodeFrame, setText, TEXT, type SyncSession } from '@brian/sync';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addMember, call, connect, ORIGIN, signedInUser, tool } from './helpers';

const account = exports.Account;
let seq = 0;

type Frame = { header: Record<string, unknown>; payloads: Uint8Array[] };

async function person(name: string) {
	const username = `${name}${++seq}`;
	const { user, jar } = await signedInUser(`${username}@example.com`, username);
	return { user, token: await connect(jar), name: username };
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.value;
}

async function session(token: string): Promise<SyncSession> {
	const response = await call('/mcp/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
	expect(response.status).toBe(200);
	return response.json();
}

const pid = () => `p_${crypto.randomUUID()}`;

/** A device: one sync WebSocket, requests matched to replies by ref, and the pushes it received. */
class Device {
	private ref = 0;
	private waiting = new Map<number, (frame: Frame) => void>();
	readonly pushes: Frame[] = [];
	private pushWaiters: (() => void)[] = [];
	closed: number | null = null;

	private constructor(readonly ws: WebSocket) {
		// Delivered in order, whatever form the data comes in (a Blob here, an ArrayBuffer in browsers set up for it).
		let queue = Promise.resolve();
		ws.addEventListener('message', (event) => {
			const data = event.data as ArrayBuffer | Blob;
			queue = queue.then(async () => this.deliver(decodeFrame(data instanceof Blob ? await data.arrayBuffer() : data)));
		});
		ws.addEventListener('close', (event) => {
			this.closed = event.code;
		});
	}

	private deliver(frame: Frame): void {
		{
			const ref = frame.header.ref as number | undefined;
			if (ref && this.waiting.has(ref)) {
				this.waiting.get(ref)!(frame);
				this.waiting.delete(ref);
			} else {
				this.pushes.push(frame);
				this.pushWaiters.splice(0).forEach((wake) => wake());
			}
		}
	}

	static async open(ticket: string): Promise<Device> {
		const response = await call(`/sync/socket?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: 'websocket' } });
		if (!response.webSocket) throw new Error(`No socket: ${response.status} ${await response.text()}`);
		response.webSocket.accept();
		return new Device(response.webSocket);
	}

	request(header: Record<string, unknown>, payloads: Uint8Array[] = []): Promise<Frame> {
		const ref = ++this.ref;
		const reply = new Promise<Frame>((resolve) => this.waiting.set(ref, resolve));
		this.ws.send(encodeFrame({ ...header, ref }, payloads));
		return reply;
	}

	/** Waits until at least `count` pushes have arrived. */
	async received(count: number): Promise<Frame[]> {
		for (let i = 0; i < 50 && this.pushes.length < count; i++) {
			await Promise.race([new Promise<void>((wake) => this.pushWaiters.push(wake)), new Promise((r) => setTimeout(r, 20))]);
		}
		return this.pushes;
	}
}

/** A Yjs document holding `text`, as a device would make for a new page. */
function docOf(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText(TEXT).insert(0, text);
	return doc;
}

/** Changes `doc` to read `text` and returns just that edit, as an update. */
function edit(doc: Y.Doc, text: string): Uint8Array {
	const before = Y.encodeStateVector(doc);
	doc.transact(() => setText(doc.getText(TEXT), text));
	return Y.encodeStateAsUpdate(doc, before);
}

async function personalDevice(token: string) {
	const s = await session(token);
	return Device.open(s.brians.find((b) => b.id === null)!.ticket);
}

describe('sync tickets', () => {
	it('need the OAuth token, and list a ticket per brian with the role', async () => {
		expect((await call('/mcp/sync', { method: 'POST' })).status).toBe(401);
		const ann = await person('ann');
		const shared = value(await account.createBrian(ann.user.id, 'acme', 'private')) as BrianSummary;
		const s = await session(ann.token);
		expect(s.username).toBe(ann.name);
		expect(s.brians.map((b) => [b.id, b.mount, b.role])).toEqual([
			[null, null, 'owner'],
			[shared.id, 'acme', 'owner']
		]);
		expect(s.brians[0].ticket.startsWith(`${ann.user.id}.`)).toBe(true);
	});

	it('can be asked for one brian at a time', async () => {
		const ann = await person('ann');
		const shared = value(await account.createBrian(ann.user.id, 'acme', 'private')) as BrianSummary;
		const one = async (brian: string) =>
			((await (await call(`/mcp/sync?brian=${brian}`, { method: 'POST', headers: { Authorization: `Bearer ${ann.token}` } })).json()) as SyncSession).brians;
		expect((await one('personal')).map((b) => b.id)).toEqual([null]);
		expect((await one(shared.id)).map((b) => b.id)).toEqual([shared.id]);
		expect(await one('b_00000000-0000-0000-0000-000000000000')).toEqual([]);
	});

	it('let a member rename where a shared brian appears in their own Brian, and only theirs', async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const shared = value(await account.createBrian(ann.user.id, 'acme', 'private')) as BrianSummary;
		value(await addMember(ann.user.id, shared.id, bo.name, 'editor'));
		await tool(ann.token, 'write_page', { path: 'brian/mine/a.md', content: 'own' });
		const rename = (token: string, mount: string, brian = shared.id) =>
			call('/mcp/sync/mount', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ brian, mount }) });
		expect((await rename(ann.token, 'work')).status).toBe(200);
		expect((await session(ann.token)).brians.find((b) => b.id === shared.id)!.mount).toBe('work');
		expect((await session(ann.token)).brians.find((b) => b.id === shared.id)!.name).toBe('work');
		expect((await session(bo.token)).brians.find((b) => b.id === shared.id)!.mount).toBe('acme');
		// A member renaming their folder changes only their folder, not the brian's name.
		expect((await rename(bo.token, 'bos-copy')).status).toBe(200);
		expect((await session(bo.token)).brians.find((b) => b.id === shared.id)!.name).toBe('work');
		// Agents follow the new folder.
		await tool(ann.token, 'write_page', { path: 'brian/work/b.md', content: 'shared' });
		expect((await tool(bo.token, 'read_page', { path: 'brian/bos-copy/b.md' })).text).toContain('shared');
		for (const bad of ['Not Valid!', ann.name, 'mine']) expect((await rename(ann.token, bad)).status).toBe(409);
		expect((await rename(ann.token, 'x', 'b_00000000-0000-0000-0000-000000000000')).status).toBe(409);
		expect((await call('/mcp/sync/mount', { method: 'POST', body: '{}' })).status).toBe(401);
	});

	it('lets the Obsidian plugin sign in with an obsidian:// redirect', async () => {
		const redirect = 'obsidian://brian-auth';
		const registered = await call('/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_name: 'Obsidian', redirect_uris: [redirect], token_endpoint_auth_method: 'none' })
		});
		expect(registered.status).toBe(201);
		const { client_id } = (await registered.json()) as { client_id: string };
		const { jar } = await signedInUser(`obs-${crypto.randomUUID().slice(0, 6)}@example.com`);
		const url = new URL('/authorize', 'http://x');
		url.search = new URLSearchParams({
			response_type: 'code',
			client_id,
			redirect_uri: redirect,
			scope: 'brian',
			state: 's',
			code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
			code_challenge_method: 'S256',
			resource: `${ORIGIN}/mcp`
		}).toString();
		const consent = await jar.fetch(url.pathname + url.search);
		expect(consent.status).toBe(200);
		const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
		const approved = await jar.fetch('/authorize', { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
		expect(approved.headers.get('Location')).toMatch(/^obsidian:\/\/brian-auth\?code=/);
	});

	it('open one socket each, once, and nothing else does', async () => {
		const ann = await person('ann');
		const { ticket } = (await session(ann.token)).brians[0];
		await Device.open(ticket);
		expect((await call(`/sync/socket?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
		expect((await call(`/sync/socket?ticket=${ann.user.id}.forged`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
		expect((await call(`/sync/socket?ticket=not-a-brian.x`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
		const fresh = (await session(ann.token)).brians[0].ticket;
		expect((await call(`/sync/socket?ticket=${fresh}`)).status).toBe(426);
	});
});

describe('syncing a brian', () => {
	it('creates pages from a device, and other devices and MCP see them', async () => {
		const ann = await person('ann');
		const [laptop, phone] = [await personalDevice(ann.token), await personalDevice(ann.token)];
		const id = pid();
		const doc = docOf('hello from the laptop');
		const created = await laptop.request({ t: 'create', id, path: 'notes/hi.md' }, [Y.encodeStateAsUpdate(doc)]);
		expect(created.header).toMatchObject({ t: 'ok', path: 'notes/hi.md' });
		expect((await tool(ann.token, 'read_page', { path: 'notes/hi.md' })).text).toContain('hello from the laptop');

		const [push] = await phone.received(1);
		expect(push.header).toMatchObject({ t: 'page', id, path: 'notes/hi.md', seq: created.header.seq });
		const copy = new Y.Doc();
		Y.applyUpdate(copy, push.payloads[0]);
		expect(copy.getText(TEXT).toString()).toBe('hello from the laptop');
		expect(laptop.pushes).toEqual([]); // The sender hears back through its reply, not a push.
	});

	it('pushes MCP writes to devices, as just the edit', async () => {
		const ann = await person('ann');
		await tool(ann.token, 'write_page', { path: 'a.md', content: 'one two' });
		const device = await personalDevice(ann.token);
		const { header } = await device.request({ t: 'changes', since: 0 });
		const entry = (header.changes as { id: string; path: string }[]).find((c) => c.path === 'a.md')!;
		const pulled = await device.request({ t: 'pull', ids: [entry.id] }, [new Uint8Array()]);
		const doc = new Y.Doc();
		Y.applyUpdate(doc, pulled.payloads[0]);
		await tool(ann.token, 'edit_page', { path: 'a.md', old_string: 'two', new_string: 'three' });
		const [push] = await device.received(1);
		Y.applyUpdate(doc, push.payloads[0]);
		expect(doc.getText(TEXT).toString()).toBe('one three');
		expect(push.payloads[0].length).toBeLessThan(pulled.payloads[0].length + 20);
	});

	it('merges two devices editing the same page at once, keeping both edits', async () => {
		const ann = await person('ann');
		const [a, b] = [await personalDevice(ann.token), await personalDevice(ann.token)];
		const id = pid();
		const docA = docOf('line one\nline two\n');
		await a.request({ t: 'create', id, path: 'shared.md' }, [Y.encodeStateAsUpdate(docA)]);
		const docB = new Y.Doc();
		Y.applyUpdate(docB, (await b.received(1))[0].payloads[0]);
		// Both edit before hearing of the other's change.
		const editA = edit(docA, 'line ONE\nline two\n');
		const editB = edit(docB, 'line one\nline two, from b\n');
		await a.request({ t: 'push', id }, [editA]);
		await b.request({ t: 'push', id }, [editB]);
		Y.applyUpdate(docA, (await a.received(1))[0].payloads[0]);
		Y.applyUpdate(docB, (await b.received(2))[1].payloads[0]);
		const merged = 'line ONE\nline two, from b\n';
		expect(docA.getText(TEXT).toString()).toBe(merged);
		expect(docB.getText(TEXT).toString()).toBe(merged);
		expect((await tool(ann.token, 'read_page', { path: 'shared.md' })).text).toContain(merged);
	});

	it('catches a device up from its cursor, sending only what it lacks', async () => {
		const ann = await person('ann');
		const device = await personalDevice(ann.token);
		const id = pid();
		const doc = docOf(`START${'x'.repeat(5000)}`);
		const created = await device.request({ t: 'create', id, path: 'big.md' }, [Y.encodeStateAsUpdate(doc)]);
		const cursor = created.header.seq as number;
		await tool(ann.token, 'edit_page', { path: 'big.md', old_string: 'START', new_string: 'yy' });
		await tool(ann.token, 'write_page', { path: 'other.md', content: 'o' });
		const { header } = await device.request({ t: 'changes', since: cursor });
		expect((header.changes as { path: string }[]).map((c) => c.path)).toEqual(['big.md', 'other.md']);
		const pulled = await device.request({ t: 'pull', ids: [id] }, [Y.encodeStateVector(doc)]);
		expect(pulled.payloads[0].length).toBeLessThan(100);
		Y.applyUpdate(doc, pulled.payloads[0]);
		expect(doc.getText(TEXT).toString().startsWith('yyx')).toBe(true);
	});

	it('names a second page with the same path "name 2", and moves the same way', async () => {
		const ann = await person('ann');
		const device = await personalDevice(ann.token);
		await tool(ann.token, 'write_page', { path: 'Idea.md', content: 'server' });
		const first = await device.request({ t: 'create', id: pid(), path: 'idea.md' }, [Y.encodeStateAsUpdate(docOf('device'))]);
		expect(first.header.path).toBe('idea 2.md');
		const id = pid();
		await device.request({ t: 'create', id, path: 'other.md' }, [Y.encodeStateAsUpdate(docOf('o'))]);
		expect((await device.request({ t: 'move', id, path: 'IDEA.md' })).header.path).toBe('IDEA 3.md');
		expect((await device.request({ t: 'move', id, path: 'Other.md' })).header.path).toBe('Other.md');
	});

	it('moves folders, numbering clashes instead of refusing', async () => {
		const ann = await person('ann');
		const device = await personalDevice(ann.token);
		await tool(ann.token, 'write_page', { path: 'src/a.md', content: 'a' });
		await tool(ann.token, 'write_page', { path: 'dst/a.md', content: 'taken' });
		await device.request({ t: 'moveFolder', from: 'src', to: 'dst' });
		expect((await tool(ann.token, 'list', { prefix: 'dst/' })).text.split('\n').sort()).toEqual(['dst/a 2.md', 'dst/a.md']);
	});

	it('only deletes what the device has seen, and an edit brings a deleted page back', async () => {
		const ann = await person('ann');
		const device = await personalDevice(ann.token);
		const id = pid();
		const doc = docOf('keep me');
		await device.request({ t: 'create', id, path: 'p.md' }, [Y.encodeStateAsUpdate(doc)]);
		await tool(ann.token, 'edit_page', { path: 'p.md', old_string: 'keep', new_string: 'KEEP' });
		const refused = await device.request({ t: 'delete', id }, [Y.encodeStateVector(doc)]);
		expect(refused.header).toMatchObject({ t: 'error', code: 'changed' });

		Y.applyUpdate(doc, (await device.received(1))[0].payloads[0]);
		expect((await device.request({ t: 'delete', id }, [Y.encodeStateVector(doc)])).header.t).toBe('ok');
		expect((await tool(ann.token, 'read_page', { path: 'p.md' })).isError).toBe(true);
		// Another device that missed the delete keeps editing: the edit wins.
		const restored = await device.request({ t: 'push', id }, [edit(doc, 'KEEP me, edited')]);
		expect(restored.header).toMatchObject({ t: 'ok', path: 'p.md' });
		expect((await tool(ann.token, 'read_page', { path: 'p.md' })).text).toContain('KEEP me, edited');
	});

	it('asks for the whole page when it has never heard of it', async () => {
		const ann = await person('ann');
		const device = await personalDevice(ann.token);
		const reply = await device.request({ t: 'push', id: pid() }, [Y.encodeStateAsUpdate(docOf('x'))]);
		expect(reply.header).toMatchObject({ t: 'error', code: 'unknown' });
	});

	it('refuses bad requests without breaking the connection', async () => {
		const ann = await person('ann');
		const device = await personalDevice(ann.token);
		expect((await device.request({ t: 'create', id: 'nope', path: 'a.md' }, [new Uint8Array()])).header.code).toBe('bad-request');
		expect((await device.request({ t: 'create', id: pid(), path: 'a:b.md' }, [Y.encodeStateAsUpdate(docOf('x'))])).header.code).toBe('refused');
		expect((await device.request({ t: 'create', id: pid(), path: 'a.png' }, [Y.encodeStateAsUpdate(docOf('x'))])).header.code).toBe('refused');
		expect((await device.request({ t: 'push', id: pid() }, [new Uint8Array([1, 2, 3])])).header.code).toMatch(/bad-request|unknown/);
		expect((await device.request({ t: 'teleport' })).header.code).toBe('bad-request');
		expect((await device.request({ t: 'changes', since: 0 })).header.t).toBe('ok');
	});
});

describe('shared brians', () => {
	it("lets viewers read but not write, and closes a member's socket when their role changes", async () => {
		const ann = await person('ann');
		const bo = await person('bo');
		const brian = value(await account.createBrian(ann.user.id, 'course', 'private')) as BrianSummary;
		value(await addMember(ann.user.id, brian.id, bo.name, 'viewer'));
		const ticketOf = async (token: string) => (await session(token)).brians.find((b) => b.id === brian.id)!.ticket;
		const owner = await Device.open(await ticketOf(ann.token));
		const viewer = await Device.open(await ticketOf(bo.token));

		const id = pid();
		await owner.request({ t: 'create', id, path: 'week1.md' }, [Y.encodeStateAsUpdate(docOf('lecture notes'))]);
		const [push] = await viewer.received(1);
		expect(push.header).toMatchObject({ t: 'page', id, path: 'week1.md' });
		const denied = await viewer.request({ t: 'push', id }, [Y.encodeStateAsUpdate(docOf('vandalism'))]);
		expect(denied.header).toMatchObject({ t: 'error', code: 'read-only' });
		expect((await viewer.request({ t: 'pull', ids: [id] }, [new Uint8Array()])).header.t).toBe('ok');

		value(await account.setRole(ann.user.id, brian.id, bo.name, 'editor'));
		for (let i = 0; i < 20 && viewer.closed === null; i++) await new Promise((r) => setTimeout(r, 10));
		expect(viewer.closed).toBe(4003);
		const editor = await Device.open(await ticketOf(bo.token));
		expect((await editor.request({ t: 'push', id }, [Y.encodeStateAsUpdate(docOf('now allowed'))])).header.t).toBe('ok');
	});
});
