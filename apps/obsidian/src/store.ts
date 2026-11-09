import type { PageRecord, SyncStore, Tombstone } from '@brian/sync';

const PAGES = 'pages';
const TOMBSTONES = 'tombstones';
const META = 'meta';

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** One brian's sync state on this device, in IndexedDB (one database per install and brian). */
export class IdbStore implements SyncStore {
	private db: Promise<IDBDatabase>;

	constructor(readonly name: string) {
		const request = indexedDB.open(name, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(PAGES, { keyPath: 'id' });
			request.result.createObjectStore(TOMBSTONES, { keyPath: 'id' });
			request.result.createObjectStore(META);
		};
		this.db = done(request);
	}

	/** Forgets a brian's state, e.g. when signing out. */
	static async destroy(name: string): Promise<void> {
		await done(indexedDB.deleteDatabase(name));
	}

	async load(): Promise<{ cursor: number; pages: PageRecord[]; tombstones: Tombstone[]; client?: number }> {
		const db = await this.db;
		const tx = db.transaction([PAGES, TOMBSTONES, META], 'readonly');
		const [pages, tombstones, cursor, client] = await Promise.all([
			done(tx.objectStore(PAGES).getAll() as IDBRequest<PageRecord[]>),
			done(tx.objectStore(TOMBSTONES).getAll() as IDBRequest<Tombstone[]>),
			done(tx.objectStore(META).get('cursor') as IDBRequest<number | undefined>),
			done(tx.objectStore(META).get('client') as IDBRequest<number | undefined>)
		]);
		return { cursor: cursor ?? 0, pages, tombstones, client };
	}

	setClient(client: number): Promise<void> {
		return this.write(META, (store) => store.put(client, 'client'));
	}

	putPage(page: PageRecord): Promise<void> {
		return this.write(PAGES, (store) => store.put(page));
	}

	deletePage(id: string): Promise<void> {
		return this.write(PAGES, (store) => store.delete(id));
	}

	putTombstone(tombstone: Tombstone): Promise<void> {
		return this.write(TOMBSTONES, (store) => store.put(tombstone));
	}

	deleteTombstone(id: string): Promise<void> {
		return this.write(TOMBSTONES, (store) => store.delete(id));
	}

	setCursor(cursor: number): Promise<void> {
		return this.write(META, (store) => store.put(cursor, 'cursor'));
	}

	private async write(name: string, fn: (store: IDBObjectStore) => IDBRequest): Promise<void> {
		const db = await this.db;
		const tx = db.transaction(name, 'readwrite');
		fn(tx.objectStore(name));
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}
}
