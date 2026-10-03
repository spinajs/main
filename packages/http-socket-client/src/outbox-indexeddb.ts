import type { FailedOutboxEntry, OutboxEntry, OutboxInput, OutboxStore } from './outbox.js';

export interface IndexedDbOutboxOptions {
  /** The IndexedDB to use; the global `indexedDB` when omitted ( tests pass fake-indexeddb's ). */
  factory?: IDBFactory;
  /** Refuse a second live store on the same name via `navigator.locks`. Default: on with the global IndexedDB, off with a custom `factory`. */
  exclusive?: boolean;
}

const PENDING = 'pending';
const FAILED = 'failed';
// A bump needs an `onblocked` strategy for connections of other tabs that ignore `versionchange`.
const VERSION = 1;

type LocksApi = { request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<unknown> };

function explain(err: unknown, name: string): unknown {
  const kind = (err as { name?: string } | null)?.name;
  switch (kind) {
    case 'QuotaExceededError':
      return new Error('outbox is full (QuotaExceededError)', { cause: err });
    case 'VersionError':
      return new Error(`outbox database "${name}" was written by a newer version of this code`, { cause: err });
    case 'NotFoundError':
      return new Error(`outbox database "${name}" has no expected object store`, { cause: err });
    default:
      return err;
  }
}

/**
 * Keeps the outbox in the IndexedDB database `spinajs-outbox:<name>`, so a reload resumes the queue
 * ( spec �6 step 5 ). `seq` comes from the object store's key generator, which never reuses a value and
 * is advanced in the transaction that stores the entry. Every method is one transaction and resolves on
 * its `complete` event, with strict durability.
 *
 * One live client per name: with the global IndexedDB and where `navigator.locks` exists, a second store on the same name is refused
 * while the first is open. The app must persist and reuse its `clientId` with this store, because
 * queued entries carry keys derived from it.
 */
export class IndexedDbOutboxStore implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;
  private releaseLock: (() => void) | null = null;
  private lockDone: Promise<unknown> | null = null;

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

  /** Closes the database connection and releases the name; the next call opens it again. */
  public async close(): Promise<void> {
    const opening = this.db;
    (await opening?.catch(() => null))?.close();
    if (this.db === opening) {
      this.db = null;
    }
    this.releaseLock?.();
    this.releaseLock = null;
    // the lock is free once its request settled
    await this.lockDone;
    this.lockDone = null;
  }

  private async acquireLock(): Promise<void> {
    const locks = (globalThis as { navigator?: { locks?: LocksApi } }).navigator?.locks;
    const exclusive = this.options.exclusive ?? this.options.factory === undefined;
    if (!exclusive || !locks || this.releaseLock) {
      return;
    }

    const taken = await new Promise<boolean>((resolve) => {
      this.lockDone = locks.request(`spinajs-outbox:${this.name}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }

        await new Promise<void>((release) => {
          this.releaseLock = release;
          resolve(true);
        });
      });
    });

    if (!taken) {
      throw new Error(`outbox "${this.name}" is already open in another tab or client; only one live client per name is allowed`);
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    const opening: Promise<IDBDatabase> = this.acquireLock().then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
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
            if (!db.objectStoreNames.contains(PENDING) || !db.objectStoreNames.contains(FAILED)) {
              db.close();
              reject(new Error(`database "spinajs-outbox:${this.name}" is not an outbox: missing object stores`));
              return;
            }

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
          request.onerror = () => reject(explain(request.error, this.name));
        }),
    );

    // a failed open is tried again by the next call
    opening.catch(() => {
      if (this.db === opening) {
        this.db = null;
      }
      if (!this.db) {
        this.releaseLock?.();
        this.releaseLock = null;
      }
    });

    this.db = opening;
    return opening;
  }

  private async run(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest): Promise<unknown> {
    let db = await this.open();
    let tx: IDBTransaction;
    try {
      tx = this.begin(db, stores, mode);
    } catch (err) {
      if ((err as { name?: string }).name !== 'InvalidStateError') {
        throw explain(err, this.name);
      }
      // the connection was closed behind our back: reopen once
      if (this.db) {
        this.db = null;
      }
      db = await this.open();
      try {
        tx = this.begin(db, stores, mode);
      } catch (again) {
        throw explain(again, this.name);
      }
    }

    return new Promise((resolve, reject) => {
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
        reject(explain(err, this.name));
        return;
      }

      tx.oncomplete = () => resolve(request.result);
      // `tx.error` is only set by the time of `abort`, never at `error`
      tx.onabort = () => reject(explain(tx.error ?? request.error, this.name) ?? new Error('IndexedDB transaction aborted'));
    });
  }

  // strict: the commit reaches the disk before `complete`, which a durable command relies on
  private begin(db: IDBDatabase, stores: string[], mode: IDBTransactionMode): IDBTransaction {
    return db.transaction(stores, mode, { durability: 'strict' });
  }
}
