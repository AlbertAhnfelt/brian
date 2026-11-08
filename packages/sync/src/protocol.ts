/**
 * The sync protocol between a device (the Obsidian plugin) and one brian's Durable Object, over a
 * WebSocket. Shared by both ends so they can't drift apart.
 *
 * Every message is one binary frame: a JSON header and zero or more binary payloads (Yjs updates
 * and state vectors), so large pages travel as raw bytes, never base64.
 *
 * Devices send requests with a `ref`; the server answers each with `ok` or `error` carrying the
 * same `ref`. The server also pushes `page` and `gone` messages whenever anything changes,
 * whoever changed it (another device, an agent over MCP, the website). Every change has a `seq`
 * from the brian's change feed: a device that has applied everything up to `seq` resumes from
 * there with `changes`.
 */

/** A page id: "p_" and a UUID. Devices generate them for pages they create, even offline. */
export const PAGE_ID = /^p_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Largest frame either end accepts, in bytes. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Largest number of pages one `pull` may ask for. */
export const MAX_PULL = 50;

export type Role = 'owner' | 'editor' | 'viewer';

/** What `POST /mcp/sync` returns: one ticket per brian, each good for one WebSocket within a minute. */
export interface SyncSession {
	username: string;
	brians: SyncBrian[];
}

export interface SyncBrian {
	/** The shared brian's id, or null for the user's personal brian. */
	id: string | null;
	name: string;
	/** The folder under brian/ (shared brians only). */
	mount: string | null;
	role: Role;
	/** Open `wss://<host>/sync/socket?ticket=<ticket>`. */
	ticket: string;
}

/** One entry of the change feed: a page as it is now, or a page that was deleted. */
export interface FeedEntry {
	seq: number;
	id: string;
	path: string;
	deleted: boolean;
}

// Device → server. Payloads are listed in the comment on each field that has them.
export type Request =
	/** Everything that changed after `since`, oldest first. */
	| { t: 'changes'; ref: number; since: number }
	/** Pages' missing edits. Payloads: one state vector per id (empty = "I have nothing"). */
	| { t: 'pull'; ref: number; ids: string[] }
	/** Edits to a page. Payload: a Yjs update. */
	| { t: 'push'; ref: number; id: string }
	/** A page made on the device. Payload: its whole Yjs state. */
	| { t: 'create'; ref: number; id: string; path: string }
	| { t: 'move'; ref: number; id: string; path: string }
	| { t: 'moveFolder'; ref: number; from: string; to: string }
	/** Payload: the page's state vector on the device, so edits it never saw survive. */
	| { t: 'delete'; ref: number; id: string };

// Server → device.
export type Reply =
	| { t: 'ok'; ref: number; seq?: number; path?: string; changes?: FeedEntry[]; cursor?: number; more?: boolean; pages?: PulledPage[] }
	| { t: 'error'; ref: number; code: ErrorCode; message: string }
	/**
	 * A page changed (created, edited, moved or restored). Payload, when there is one: the Yjs
	 * update to apply. A device that doesn't know the id creates the page from it.
	 */
	| { t: 'page'; id: string; path: string; seq: number }
	| { t: 'gone'; id: string; seq: number };

/** In a `pull` answer, in order; `update` is the payload index, `missing` means deleted or unknown. */
export type PulledPage = { id: string; path: string; seq: number; update: number } | { id: string; missing: true } | { id: string; later: true };

export type ErrorCode =
	/** The request was malformed. */
	| 'bad-request'
	/** Viewers can't change a brian. */
	| 'read-only'
	/** No page has this id, or it's been deleted for good: send `create` with the whole state. */
	| 'unknown'
	/** The page has edits the device never saw, so it wasn't deleted: `pull` it again. */
	| 'changed'
	/** The path or content broke a rule (size, path rules, page limit). Not retried. */
	| 'refused';

/** Encodes a header and payloads into one frame: [header length: u32][header JSON][payloads…]. */
export function encodeFrame(header: object, payloads: Uint8Array[] = []): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify({ ...header, sizes: payloads.map((p) => p.length) }));
	const frame = new Uint8Array(4 + json.length + payloads.reduce((n, p) => n + p.length, 0));
	new DataView(frame.buffer).setUint32(0, json.length);
	frame.set(json, 4);
	let at = 4 + json.length;
	for (const payload of payloads) {
		frame.set(payload, at);
		at += payload.length;
	}
	return frame;
}

/** Decodes a frame. Throws on anything malformed; the header is not validated beyond being an object. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): { header: Record<string, unknown>; payloads: Uint8Array[] } {
	const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (frame.length < 4 || frame.length > MAX_FRAME_BYTES) throw new Error('Bad frame size.');
	const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
	if (4 + length > frame.length) throw new Error('Bad header length.');
	const header: unknown = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length)));
	if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Bad header.');
	const sizes = (header as { sizes?: unknown }).sizes ?? [];
	if (!Array.isArray(sizes) || !sizes.every((n) => Number.isInteger(n) && n >= 0)) throw new Error('Bad payload sizes.');
	const payloads: Uint8Array[] = [];
	let at = 4 + length;
	for (const size of sizes as number[]) {
		if (at + size > frame.length) throw new Error('Payload past the end of the frame.');
		payloads.push(frame.slice(at, at + size));
		at += size;
	}
	if (at !== frame.length) throw new Error('Bytes after the last payload.');
	return { header: header as Record<string, unknown>, payloads };
}
