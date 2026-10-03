import type { FailedOutboxEntry, OutboxEntry, OutboxInput, OutboxStore } from './outbox.js';

export interface IndexedDbOutboxOptions {
  /** The IndexedDB to use; the global `indexedDB` when omitted ( tests pass fake-indexeddb's ). */
  factory?: IDBFactory;
}

const PENDING = 'pending';
const FAILED = 'failed';
const VERSION = 1;

/**
 * Keeps the outbox in the IndexedDB database `spinajs-outbox:<name>`, so a reload resumes the queue
 * ( spec §6 step 5 ). `seq` comes from the object store's key generator, which never reuses a value and
 * is advanced in the transaction that stores the entry. Every method is one transaction and resolves on
 * its `complete` event, with strict durability.
 */
export class IndexedDbOutboxStore implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(public readonly name: string, private readonly options: IndexedDbOutboxOptions = {}) {}

  public async add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    const record = { name: input.name, payload: input.payload, createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
    const seq = await this.run([PENDING], 'readwrite', (tx) => tx.objectStore(PENDING).add(record));
    // structuredClone: the caller must not share the payload with what was stored
    return { ...structuredClone(record), seq: seq as number };
  }

  public async pending(): Promise<OutboxEntry[]> {
    return (await this.run([PENDING], 'readonly', (tx) => tx.objectStore(PENDING).getAll())) as OutboxEntry[];
  }

  public async remove(seq: number): Promise<void> {
    await this.run([PENDING], 'readwrite', (tx) => tx.objectStore(PENDING).delete(seq));
  }

  public async fail(entry: FailedOutboxEntry): Promise<void> {
    await this.run([PENDING, FAILED], 'readwrite', (tx) => {
      const pending = tx.objectStore(PENDING);
      const found = pending.getKey(entry.seq);
      found.onsuccess = () => {
        if (found.result !== undefined) {
          pending.delete(entry.seq);
          tx.objectStore(FAILED).put(entry);
        }
      };
      return found;
    });
  }

  public async failed(): Promise<FailedOutboxEntry[]> {
    return (await this.run([FAILED], 'readonly', (tx) => tx.objectStore(FAILED).getAll())) as FailedOutboxEntry[];
  }

  public async clearFailed(seqs?: readonly number[]): Promise<void> {
    await this.run([FAILED], 'readwrite', (tx) => {
      const failed = tx.objectStore(FAILED);
      if (seqs === undefined) {
        return failed.clear();
      }

      let last: IDBRequest = failed.count();
      for (const seq of seqs) {
        last = failed.delete(seq);
      }
      return last;
    });
  }

  /** Closes the database connection; the next call opens it again. */
  public async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    (await db?.catch(() => null))?.close();
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    const opening: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!factory) {
        reject(new Error('IndexedDB is not available here; pass IndexedDbOutboxOptions.factory'));
        return;
      }

      const request = factory.open(`spinajs-outbox:${this.name}`, VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(PENDING, { keyPath: 'seq', autoIncrement: true });
        request.result.createObjectStore(FAILED, { keyPath: 'seq' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // A newer schema in another tab waits for this connection to go away; the next call reopens it.
        const forget = () => {
          db.close();
          if (this.db === opening) {
            this.db = null;
          }
        };
        db.onversionchange = forget;
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });

    // a failed open is tried again by the next call
    opening.catch(() => {
      if (this.db === opening) {
        this.db = null;
      }
    });

    this.db = opening;
    return opening;
  }

  private async run(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest): Promise<unknown> {
    const db = await this.open();

    return new Promise((resolve, reject) => {
      // strict: the commit reaches the disk before `complete`, which a durable command relies on
      const tx = db.transaction(stores, mode, { durability: 'strict' });
      let request: IDBRequest;
      try {
        request = work(tx);
      } catch (err) {
        // e.g. a payload structured clone cannot copy: nothing of this call may commit
        try {
          tx.abort();
        } catch {
          // already finished
        }
        reject(err);
        return;
      }

      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
