import { BrianSync, type Connect, type LocalFiles, type PageRecord, type SyncSession, type SyncStore, type Tombstone } from '@brian/sync';
import type { BrianSummary, Outcome } from '@brian/shared';
import { exports } from 'cloudflare:workers';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { addMember, call, connect as oauthConnect, signedInUser, tool } from './helpers';

/** A device's files, in memory. `typing` marks files someone is typing in. */
class Files implements LocalFiles {
	files = new Map<string, string>();
	typing = new Set<string>();
	async list() {
		return [...this.files.keys()];
	}
	async read(path: string) {
		return this.files.get(path) ?? null;
	}
	async write(path: string, text: string) {
		this.files.set(path, text);
	}
	async rename(from: string, to: string) {
		const text = this.files.get(from);
		if (text === undefined) return;
		this.files.delete(from);
		this.files.set(to, text);
	}
	async remove(path: string) {
		this.files.delete(path);
	}
	busy(path: string) {
		return this.typing.has(path);
	}
}

class Store implements SyncStore {
	cursor = 0;
	client: number | undefined;
	pages = new Map<string, PageRecord>();
	tombstones = new Map<string, Tombstone>();
	async load() {
		return { cursor: this.cursor, pages: [...this.pages.values()], tombstones: [...this.tombstones.values()], client: this.client };
	}
	async setClient(client: number) {
		this.client = client;
	}
	async putPage(page: PageRecord) {
		this.pages.set(page.id, structuredClone(page));
	}
	async deletePage(id: string) {
		this.pages.delete(id);
	}
	async putTombstone(t: Tombstone) {
		this.tombstones.set(t.id, t);
	}
	async deleteTombstone(id: string) {
		this.tombstones.delete(id);
	}
	async setCursor(cursor: number) {
		this.cursor = cursor;
	}
}

/** Connects like the plugin will: fetch a ticket with the OAuth token, then open the socket. */
function connector(token: string, brian: string | null = null): Connect {
	return async ({ message, close }) => {
		const session = (await (await call('/mcp/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json()) as SyncSession;
		const { ticket } = session.brians.find((b) => b.id === brian)!;
		const response = await call(`/sync/socket?ticket=${ticket}`, { headers: { Upgrade: 'websocket' } });
		const ws = response.webSocket;
		if (!ws) throw new Error(`Could not connect: ${response.status}`);
		ws.accept();
		let queue = Promise.resolve();
		ws.addEventListener('message', (event) => {
			const data = event.data as ArrayBuffer | Blob;
			queue = queue.then(async () => message(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)));
		});
		ws.addEventListener('close', (event) => close(event.code));
		return { send: (frame) => ws.send(frame), close: () => ws.close() };
	};
}

/** A device: its files, its saved state, and (while running) its engine. */
/** A device's files, minus the root BRIAN.md that Brian writes into every Brian. */
const notes = (device: Device) => [...device.files.files.keys()].filter((path) => path !== 'BRIAN.md').sort();

class Device {
	files = new Files();
	store = new Store();
	engine: BrianSync | null = null;
	retry = [50];
	constructor(
		private token: string,
		private readOnly = false,
		private brian: string | null = null
	) {}
	async start() {
		this.engine = new BrianSync({
			files: this.files,
			store: this.store,
			connect: connector(this.token, this.brian),
			readOnly: this.readOnly,
			retryDelays: this.retry,
			busyRetryMs: 20
		});
		await this.engine.start();
	}
	async stop() {
		await this.engine?.stop();
		this.engine = null;
	}
	/** Saves a file as Obsidian would, and tells the engine. */
	async save(path: string, text: string) {
		this.files.files.set(path, text);
		await this.engine?.fileChanged(path);
	}
}

/** Lets every device finish syncing: connected, nothing queued, nothing in flight. */
async function quiet(...devices: Device[]) {
	for (let round = 0; round < 40; round++) {
		await new Promise((r) => setTimeout(r, 25));
		await Promise.all(devices.map((d) => d.engine?.idle()));
		if (devices.every((d) => !d.engine || d.engine.status().state === 'synced') && round > 4) {
			await new Promise((r) => setTimeout(r, 25));
			await Promise.all(devices.map((d) => d.engine?.idle()));
			return;
		}
	}
	throw new Error(`Never settled: ${devices.map((d) => d.engine?.status().state).join(', ')}`);
}

async function user(name: string) {
	const { jar } = await signedInUser(`${name}-${crypto.randomUUID().slice(0, 6)}@example.com`);
	return oauthConnect(jar);
}

const read = async (token: string, path: string) => (await tool(token, 'read_page', { path })).text.split('\n\n').slice(1).join('\n\n');

describe('the sync engine, with devices against the real server', () => {
	it('brings a new file on one device to the other and to MCP', async () => {
		const token = await user('ann');
		const [laptop, phone] = [new Device(token), new Device(token)];
		await laptop.start();
		await phone.start();
		await quiet(laptop, phone);
		await laptop.save('notes/idea.md', 'a thought');
		await quiet(laptop, phone);
		expect(phone.files.files.get('notes/idea.md')).toBe('a thought');
		expect(await read(token, 'notes/idea.md')).toBe('a thought');
	});

	it('writes agent edits into files', async () => {
		const token = await user('ann');
		const laptop = new Device(token);
		await laptop.start();
		await laptop.save('todo.md', '- milk\n');
		await quiet(laptop);
		await tool(token, 'edit_page', { path: 'todo.md', old_string: '- milk\n', new_string: '- milk\n- eggs\n' });
		await quiet(laptop);
		expect(laptop.files.files.get('todo.md')).toBe('- milk\n- eggs\n');
	});

	it('merges edits made offline on two devices, keeping both', async () => {
		const token = await user('ann');
		const [a, b] = [new Device(token), new Device(token)];
		await a.start();
		await b.start();
		await a.save('plan.md', 'first line\nsecond line\n');
		await quiet(a, b);
		await a.stop();
		await b.stop();
		a.files.files.set('plan.md', 'FIRST line\nsecond line\n');
		b.files.files.set('plan.md', 'first line\nsecond line, from b\n');
		await a.start();
		await b.start();
		await quiet(a, b);
		await quiet(a, b);
		const merged = 'FIRST line\nsecond line, from b\n';
		expect(a.files.files.get('plan.md')).toBe(merged);
		expect(b.files.files.get('plan.md')).toBe(merged);
		expect(await read(token, 'plan.md')).toBe(merged);
	});

	it('holds a remote change back while someone types, then merges both', async () => {
		const token = await user('ann');
		const [a, b] = [new Device(token), new Device(token)];
		await a.start();
		await b.start();
		await a.save('note.md', 'hello world');
		await quiet(a, b);
		b.files.typing.add('note.md');
		b.files.files.set('note.md', 'hello world, typing'); // Unsaved typing on b.
		await a.save('note.md', 'HELLO world');
		await quiet(a, b);
		expect(b.files.files.get('note.md')).toBe('hello world, typing'); // Not overwritten mid-typing.
		b.files.typing.delete('note.md');
		await b.engine!.fileChanged('note.md');
		await quiet(a, b);
		expect(b.files.files.get('note.md')).toBe('HELLO world, typing');
		expect(a.files.files.get('note.md')).toBe('HELLO world, typing');
	});

	it('syncs renames and deletes', async () => {
		const token = await user('ann');
		const [a, b] = [new Device(token), new Device(token)];
		await a.start();
		await b.start();
		await a.save('old.md', 'x');
		await quiet(a, b);
		a.files.files.delete('old.md');
		a.files.files.set('new.md', 'x');
		await a.engine!.fileRenamed('old.md', 'new.md');
		await quiet(a, b);
		expect(notes(b)).toEqual(['new.md']);
		a.files.files.delete('new.md');
		await a.engine!.fileDeleted('new.md');
		await quiet(a, b);
		expect(notes(b)).toEqual([]);
		expect((await tool(token, 'list', { prefix: '' })).text).toBe('BRIAN.md');
	});

	it('syncs folder renames and folder deletes', async () => {
		const token = await user('ann');
		const [a, b] = [new Device(token), new Device(token)];
		await a.start();
		await b.start();
		await a.save('proj/one.md', '1');
		await a.save('proj/deep/two.md', '2');
		await quiet(a, b);
		for (const [from, to] of [['proj/one.md', 'work/one.md'], ['proj/deep/two.md', 'work/deep/two.md']]) {
			a.files.files.set(to, a.files.files.get(from)!);
			a.files.files.delete(from);
		}
		await a.engine!.folderRenamed('proj', 'work');
		await quiet(a, b);
		expect(notes(b)).toEqual(['work/deep/two.md', 'work/one.md']);
		for (const path of notes(a)) a.files.files.delete(path);
		await a.engine!.folderDeleted('work/');
		await quiet(a, b);
		expect(notes(b)).toEqual([]);
	});

	it('keeps a page one device deleted while another edited it', async () => {
		const token = await user('ann');
		const [a, b] = [new Device(token), new Device(token)];
		await a.start();
		await b.start();
		await a.save('shared.md', 'v1');
		await quiet(a, b);
		await a.stop();
		a.files.files.delete('shared.md'); // Deleted while a was offline.
		await b.save('shared.md', 'v2 from b');
		await quiet(b);
		await a.start();
		await quiet(a, b);
		expect(a.files.files.get('shared.md')).toBe('v2 from b');
		expect(b.files.files.get('shared.md')).toBe('v2 from b');
		expect(await read(token, 'shared.md')).toBe('v2 from b');
	});

	it('installs into a vault with notes: same text is adopted, different text kept as "name 2"', async () => {
		const token = await user('ann');
		await tool(token, 'write_page', { path: 'same.md', content: 'identical' });
		await tool(token, 'write_page', { path: 'differ.md', content: 'server version' });
		const fresh = new Device(token);
		fresh.files.files.set('same.md', 'identical');
		fresh.files.files.set('differ.md', 'local version');
		fresh.files.files.set('only-local.md', 'mine');
		await fresh.start();
		await quiet(fresh);
		await quiet(fresh);
		expect(Object.fromEntries(fresh.files.files)).toMatchObject({
			'same.md': 'identical',
			'differ.md': 'server version',
			'differ 2.md': 'local version',
			'only-local.md': 'mine'
		});
		const listed = (await tool(token, 'list', { prefix: '' })).text.split('\n').filter((l) => l.endsWith('.md') && l !== 'BRIAN.md').sort();
		expect(listed).toEqual(['differ 2.md', 'differ.md', 'only-local.md', 'same.md']);
	});

	it('names the second of two offline creates with the same path "name 2" everywhere', async () => {
		const token = await user('ann');
		const [a, b] = [new Device(token), new Device(token)];
		await a.start();
		await b.start();
		await quiet(a, b);
		await a.stop();
		await b.stop();
		a.files.files.set('idea.md', 'from a');
		b.files.files.set('idea.md', 'from b');
		await a.start();
		await quiet(a);
		await b.start();
		await quiet(a, b);
		await quiet(a, b);
		const expected = { 'idea.md': 'from a', 'idea 2.md': 'from b' };
		for (const device of [a, b]) expect(Object.fromEntries(notes(device).map((path) => [path, device.files.files.get(path)]))).toEqual(expected);
	});
});

describe('hardening', () => {
	it('syncs a page the server refused once it is renamed to a name it accepts', async () => {
		const token = await user('ann');
		const laptop = new Device(token);
		await laptop.start();
		await laptop.save('what?.md', 'x');
		await quiet(laptop);
		expect(laptop.engine!.status().problems.map((p) => p.path)).toEqual(['what?.md']);
		laptop.files.files.delete('what?.md');
		laptop.files.files.set('what-.md', 'x');
		await laptop.engine!.fileRenamed('what?.md', 'what-.md');
		await quiet(laptop);
		expect(laptop.engine!.status().problems).toEqual([]);
		expect(await read(token, 'what-.md')).toBe('x');
	});

	it('keeps one Yjs client per device across restarts, so pages do not grow with every launch', async () => {
		const token = await user('ann');
		const laptop = new Device(token);
		for (let run = 0; run < 3; run++) {
			await laptop.start();
			await laptop.save('a.md', `run ${run}`);
			await quiet(laptop);
			await laptop.stop();
		}
		const [record] = [...laptop.store.pages.values()];
		expect(Y.decodeStateVector(Y.encodeStateVectorFromUpdate(record.state)).size).toBe(1);
	});

	it('compares everything when the server is behind the device, and loses nothing', async () => {
		const token = await user('ann');
		const laptop = new Device(token);
		await laptop.start();
		await laptop.save('a.md', 'kept');
		await quiet(laptop);
		await laptop.stop();
		laptop.store.cursor = 1_000_000; // As if the brian had been reset since.
		await laptop.start();
		await quiet(laptop);
		expect(laptop.store.cursor).toBeLessThan(1_000_000);
		expect(laptop.files.files.get('a.md')).toBe('kept');
		await tool(token, 'write_page', { path: 'b.md', content: 'new' });
		await quiet(laptop);
		expect(laptop.files.files.get('b.md')).toBe('new');
	});

	it('syncs at once when asked, instead of waiting to reconnect', async () => {
		const token = await user('ann');
		const laptop = new Device(token);
		laptop.retry = [60_000];
		await laptop.start();
		await quiet(laptop);
		await tool(token, 'write_page', { path: 'c.md', content: 'now' });
		await laptop.engine!.syncNow();
		expect(laptop.files.files.get('c.md')).toBe('now');
	});
});

describe('viewers and many devices', () => {
	it("syncs a shared brian to a viewer, whose own edits never leave and last until the next update", async () => {
		const owner = await signedInUser(`own-${crypto.randomUUID().slice(0, 6)}@example.com`, `own${crypto.randomUUID().slice(0, 6)}`);
		const viewer = await signedInUser(`view-${crypto.randomUUID().slice(0, 6)}@example.com`, `view${crypto.randomUUID().slice(0, 6)}`);
		const brian = (await exports.Account.createBrian(owner.user.id, 'course', 'private')) as Outcome<BrianSummary>;
		if (!brian.ok) throw new Error(brian.message);
		await addMember(owner.user.id, brian.value.id, viewer.user.username!, 'viewer');
		const teacher = new Device(await oauthConnect(owner.jar), false, brian.value.id);
		const student = new Device(await oauthConnect(viewer.jar), true, brian.value.id);
		await teacher.start();
		await student.start();
		await teacher.save('week1.md', 'lecture 1');
		await quiet(teacher, student);
		expect(student.files.files.get('week1.md')).toBe('lecture 1');
		await student.save('week1.md', 'lecture 1 + my notes');
		await student.save('mine.md', 'private scribbles');
		await quiet(teacher, student);
		expect(teacher.files.files.get('week1.md')).toBe('lecture 1');
		expect(teacher.files.files.has('mine.md')).toBe(false);
		expect(student.files.files.get('week1.md')).toBe('lecture 1 + my notes');
		await teacher.save('week1.md', 'lecture 1, corrected');
		await quiet(teacher, student);
		expect(student.files.files.get('week1.md')).toBe('lecture 1, corrected');
		expect(student.files.files.get('mine.md')).toBe('private scribbles');
	});

	it.each([99, 7, 1234, 42, 2026])('converges with three devices editing at random, going offline and coming back (seed %i)', async (start) => {
		const token = await user('stress');
		const devices = [new Device(token), new Device(token), new Device(token)];
		for (const d of devices) await d.start();
		await devices[0].save('shared.md', 'alpha beta gamma\ndelta epsilon\n');
		await quiet(...devices);
		let seed = start;
		const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		const words = ['red ', 'blue ', '😀 ', 'å ', '\n', 'x'];
		for (let round = 0; round < 12; round++) {
			for (const d of devices) {
				if (rand() < 0.25) {
					if (d.engine) await d.stop();
					else await d.start();
				}
				const text = d.files.files.get('shared.md') ?? '';
				const at = Math.floor(rand() * (text.length + 1));
				const cut = rand() < 0.3 ? Math.ceil(rand() * 4) : 0;
				// Never cut through an emoji: a real editor never would.
				const safeAt = /[\udc00-\udfff]/.test(text[at] ?? '') ? at + 1 : at;
				const end = Math.min(text.length, safeAt + cut);
				const safeEnd = /[\udc00-\udfff]/.test(text[end] ?? '') ? end + 1 : end;
				const next = text.slice(0, safeAt) + words[Math.floor(rand() * words.length)] + text.slice(safeEnd);
				if (d.engine) await d.save('shared.md', next);
				else d.files.files.set('shared.md', next);
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		for (const d of devices) if (!d.engine) await d.start();
		await quiet(...devices);
		await quiet(...devices);
		const final = await read(token, 'shared.md');
		for (const d of devices) expect(d.files.files.get('shared.md')).toBe(final);
		expect(final.length).toBeGreaterThan(10);
	});
});
