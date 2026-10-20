# Outbox stores

An `OutboxStore` is where [durable commands](04-durable-commands.md) wait for their reply. The package ships three: in memory, in IndexedDB for browsers, and in a JSON file for Node. Implement the interface to keep the outbox anywhere else, or wrap a shipped store to observe it.

## How it works

1. You pass a store as the `outbox` option; without one, the client creates a `MemoryOutboxStore`. Any explicit store requires a `clientId`.
2. On construction the durable queue calls `pending()` once and resumes the entries it returns, in `seq` order.
3. Each `durable()` call goes through `add()`. The queue sends the command only after `add()` resolved.
4. An acknowledged command is removed with `remove(seq)`. A command the server refused for good moves to the failed list with `fail(entry)`.
5. The app reads the failed list with `failed()` and clears it with `clearFailed(seqs?)`. The queue never reads it.

### The `OutboxStore` contract

| Method | Must do |
| --- | --- |
| `add(input)` | Store `{ name, payload, key? }` with a new `seq` and `createdAt` (ms epoch), and resolve with the entry. Leave `key` out when the input has none. |
| `pending()` | Resolve with the entries not yet removed or failed, in ascending `seq`. |
| `remove(seq)` | Delete the pending entry; ignore an unknown `seq`. |
| `fail(entry)` | Move the pending entry `entry.seq` to the failed list as `entry`; ignore it when that `seq` is not pending. |
| `failed()` | Resolve with the failed list, in ascending `seq`. |
| `clearFailed(seqs?)` | Delete the given failed entries, or all of them when `seqs` is omitted. |

Every implementation also keeps these rules, which the shipped stores share through one test suite:

- `seq` is strictly increasing and never reused, even after the newest entry was removed or the failed list was cleared, and across a reopen.
- Every method resolves only once its change is durable in the store's medium.
- Parallel `add()` calls get distinct, increasing `seq` values; concurrent `add`, `remove` and `fail` leave a consistent state.
- Callers and the store share no objects: clone payloads in and out.
- One `SocketClient` at a time per store.

## Configuration

`IndexedDbOutboxStore(name, options)` from `@spinajs/http-socket-client/browser`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `name` | `string` | required | | Database `spinajs-outbox:<name>`; also the lock name. |
| `options.factory` | `IDBFactory` | the global `indexedDB` | any `IDBFactory` | The IndexedDB to use, for example `fake-indexeddb` in tests. |
| `options.exclusive` | `boolean` | `true` with the global IndexedDB, `false` with a custom `factory` | | Refuse a second live store on the same name through `navigator.locks`. |

`FileOutboxStore(path, options)` from `@spinajs/http-socket-client/node`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `path` | `string` | required | file path | The JSON file; its directory is created when missing. |
| `options.retryDelayMs` | `number` | `10` | `>= 0` | Base of the backoff between rename retries; grows linearly, capped at 5x. |
| `options.rename` | `(from, to) => Promise<void>` | `fs.promises.rename` | | Test seam: the rename that publishes the temp file. |

```ts
import { IndexedDbOutboxStore } from '@spinajs/http-socket-client/browser';
import { FileOutboxStore } from '@spinajs/http-socket-client/node';

const browserStore = new IndexedDbOutboxStore('editor');
const nodeStore = new FileOutboxStore('/var/lib/worker/outbox.json', { retryDelayMs: 20 });
```

## Schema

### IndexedDB database `spinajs-outbox:<name>`, version 1

Object store `pending`, key path `seq`, auto-increment:

| Column | Type | Meaning |
| --- | --- | --- |
| `seq` | `number` | Queue position from the key generator; never reused. |
| `name` | `string` | Command name. |
| `payload` | any structured-cloneable value | Command payload; binary is kept as is. |
| `key` | `string`, optional | Idempotency key. |
| `createdAt` | `number` | ms epoch. |

Object store `failed`, key path `seq`: the same columns, plus:

| Column | Type | Meaning |
| --- | --- | --- |
| `error` | `SocketError` | The server's refusal. |
| `failedAt` | `number` | ms epoch. |

### File written by `FileOutboxStore`

| Column | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Format version; any other value is refused. |
| `seq` | `number` | Last `seq` handed out, kept so a `seq` is never reused. |
| `pending` | `OutboxEntry[]` | Entries waiting for a reply, ascending `seq`. |
| `failed` | `FailedOutboxEntry[]` | Refused entries, ascending `seq`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `OutboxStore` | none; `outbox` option of `SocketClient`, one instance per client | `MemoryOutboxStore` (main entry) | `IndexedDbOutboxStore` (`/browser`), `FileOutboxStore` (`/node`) | Implement the interface and pass it as `outbox`, or wrap a shipped store and delegate. |

### Shipped stores

| Store | Survives a reload | Payloads | Durability | Exclusivity |
| --- | --- | --- | --- | --- |
| `MemoryOutboxStore` | no | anything `structuredClone` copies | process memory | none |
| `IndexedDbOutboxStore` | yes | anything IndexedDB clones, binary included | one transaction per call, `durability: 'strict'` | `navigator.locks`, per name |
| `FileOutboxStore` | yes | JSON-safe values only | temp file, `fsync`, rename, directory `fsync` (not on Windows) | none: one process per file |

### OutboxStore: custom implementation

Write your own store when the app already has a durable medium: Web Storage in a small widget, SQLite in an Electron app, a key-value store in React Native. This one keeps the outbox in one `Storage` key. `Storage.setItem` is synchronous and durable once it returns, so every method resolves after it.

```ts sample
import { SocketClient, type FailedOutboxEntry, type OutboxEntry, type OutboxInput, type OutboxStore } from '@spinajs/http-socket-client';

interface StoredOutbox {
  seq: number;
  pending: OutboxEntry[];
  failed: FailedOutboxEntry[];
}

/** Keeps the outbox as JSON in one Web Storage key; payloads must be JSON-safe. */
export class WebStorageOutboxStore implements OutboxStore {
  constructor(private readonly storage: Storage, private readonly storageKey: string) {}

  public async add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    const state = this.read();
    const entry: OutboxEntry<P> = { seq: ++state.seq, name: input.name, payload: input.payload, createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
    state.pending.push(entry);
    this.write(state);
    return JSON.parse(JSON.stringify(entry)) as OutboxEntry<P>;
  }

  public async pending(): Promise<OutboxEntry[]> {
    return this.read().pending;
  }

  public async remove(seq: number): Promise<void> {
    const state = this.read();
    state.pending = state.pending.filter((entry) => entry.seq !== seq);
    this.write(state);
  }

  public async fail(entry: FailedOutboxEntry): Promise<void> {
    const state = this.read();
    if (!state.pending.some((pending) => pending.seq === entry.seq)) return;
    state.pending = state.pending.filter((pending) => pending.seq !== entry.seq);
    state.failed = [...state.failed, entry].sort((a, b) => a.seq - b.seq);
    this.write(state);
  }

  public async failed(): Promise<FailedOutboxEntry[]> {
    return this.read().failed;
  }

  public async clearFailed(seqs?: readonly number[]): Promise<void> {
    const state = this.read();
    state.failed = seqs === undefined ? [] : state.failed.filter((entry) => !seqs.includes(entry.seq));
    this.write(state);
  }

  // every read parses a fresh copy, so callers never share objects with the store
  private read(): StoredOutbox {
    const text = this.storage.getItem(this.storageKey);
    return text === null ? { seq: 0, pending: [], failed: [] } : (JSON.parse(text) as StoredOutbox);
  }

  private write(state: StoredOutbox): void {
    // throws QuotaExceededError when full, which rejects the caller's durable() promise
    this.storage.setItem(this.storageKey, JSON.stringify(state));
  }
}

export function connectWidget(clientId: string): SocketClient {
  return new SocketClient({
    url: 'https://app.example.com',
    clientId,
    outbox: new WebStorageOutboxStore(localStorage, `outbox:${clientId}`),
  });
}
```

`seq` stays monotonic because the counter is stored next to the entries and only grows. Parallel calls are safe because each method reads, changes and writes in one synchronous turn.

### OutboxStore: extend a shipped store

Wrap a store instead of replacing it when you only need to observe it: a "3 edits waiting" badge, metrics, an audit log. Delegate every method and act after the inner store resolved.

```ts sample
import { SocketClient, type FailedOutboxEntry, type OutboxEntry, type OutboxInput, type OutboxStore } from '@spinajs/http-socket-client';
import { IndexedDbOutboxStore } from '@spinajs/http-socket-client/browser';

/** Reports how many durable commands are waiting, after each change the inner store made durable. */
export class CountingOutboxStore implements OutboxStore {
  private waiting = 0;

  constructor(private readonly inner: OutboxStore, private readonly onCount: (waiting: number) => void) {}

  public async add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    const entry = await this.inner.add(input);
    this.report(this.waiting + 1);
    return entry;
  }

  public async pending(): Promise<OutboxEntry[]> {
    const entries = await this.inner.pending();
    this.report(entries.length);
    return entries;
  }

  public async remove(seq: number): Promise<void> {
    await this.inner.remove(seq);
    this.report(Math.max(0, this.waiting - 1));
  }

  public async fail(entry: FailedOutboxEntry): Promise<void> {
    await this.inner.fail(entry);
    this.report(Math.max(0, this.waiting - 1));
  }

  public failed(): Promise<FailedOutboxEntry[]> {
    return this.inner.failed();
  }

  public clearFailed(seqs?: readonly number[]): Promise<void> {
    return this.inner.clearFailed(seqs);
  }

  private report(waiting: number): void {
    this.waiting = waiting;
    this.onCount(waiting);
  }
}

export function connectEditor(clientId: string, badge: HTMLElement): SocketClient {
  const store = new CountingOutboxStore(new IndexedDbOutboxStore('editor'), (waiting) => {
    badge.textContent = waiting === 0 ? 'All changes saved' : `${waiting} change(s) waiting`;
  });
  return new SocketClient({ url: 'https://app.example.com', clientId, outbox: store });
}
```

## Important behaviour

- `MemoryOutboxStore` loses everything on reload, and its `seq` restarts at `1` per instance. It clones payloads in and out with `structuredClone`.
- `IndexedDbOutboxStore` opens its database on the first call, not in the constructor. A second store on the same name, while the first is open, rejects that first call with "already open in another tab or client". `SocketClient.close()` does **not** close the store: call `store.close()` to release the database and the lock, or reuse the same store instance for the next client.
- `IndexedDbOutboxStore` maps `QuotaExceededError` to "outbox is full", `VersionError` to "written by a newer version of this code", and refuses a database without the `pending` and `failed` object stores. A connection closed behind its back is reopened once.
- `FileOutboxStore.add()` rejects with a `TypeError`, and writes nothing, for a payload a JSON round trip would change: `Uint8Array`, `Buffer`, `ArrayBuffer`, `Date`, `Map`, `Set`, class instances, `NaN`, `Infinity`, `undefined` inside an array. An `undefined` property is allowed: the wire drops it too. Encode bytes as base64 and dates as ISO strings.
- `FileOutboxStore` rewrites the whole file on each commit, through `<path>.tmp`, `fsync` and rename: a crash leaves the old queue or the new one. Changes queued while a write is in flight are committed together. It suits queues of up to some thousands of entries.
- `FileOutboxStore` retries the rename up to 5 times on `EPERM`, `EBUSY` and `EACCES` (Windows and antivirus scanners). A failed write rejects the whole batch, and the next call reloads the queue from the file.
- `FileOutboxStore` refuses a damaged file, a format other than version 1, a malformed entry, and a `seq` counter behind its entries. It does not lock the file: two processes on one file overwrite each other.
- A store opened on the same medium while an old client still writes can overwrite newer data from a stale copy. `await client.close()` first.

## Best practices

- Use `IndexedDbOutboxStore` in browsers and `FileOutboxStore` in Node services; keep `MemoryOutboxStore` for tests and for queues that may be lost.
- Name the IndexedDB outbox per user or per account when one browser profile serves several, and pair it with a `clientId` stored next to it.
- In a custom store, test the contract rules above: monotonic `seq` across a reopen, ascending order, no shared objects.
- Keep `fail()` a single atomic move; an entry in both lists would be sent again and also reported as failed.

## Patterns and antipatterns

```ts
// Don't: a fresh store per client on the same name; the old one still holds the lock and the database
await client.close();
client = new SocketClient({ url, clientId, outbox: new IndexedDbOutboxStore('editor') });

// Do: close the store too, or reuse it
await client.close();
await store.close();
client = new SocketClient({ url, clientId, outbox: new IndexedDbOutboxStore('editor') });
```

```ts
// Don't: seq taken from the entry count is reused after a remove, and the server may replay an old reply
const entry = { seq: state.pending.length + 1, ...input };

// Do: keep a counter that only grows, persisted with the entries
const entry = { seq: ++state.seq, ...input };
```

## Examples

### Switch the signed-in user in a browser tab

```ts sample
import { SocketClient } from '@spinajs/http-socket-client';
import { IndexedDbOutboxStore } from '@spinajs/http-socket-client/browser';

interface Session {
  client: SocketClient;
  store: IndexedDbOutboxStore;
}

export function openSession(userId: string, clientId: string): Session {
  const store = new IndexedDbOutboxStore(`user-${userId}`);
  const client = new SocketClient({ url: 'https://app.example.com', clientId, outbox: store });
  return { client, store };
}

export async function switchUser(current: Session, nextUserId: string, nextClientId: string): Promise<Session> {
  // the queue of the old user stays in its database and resumes at their next sign-in
  await current.client.close();
  await current.store.close();
  return openSession(nextUserId, nextClientId);
}
```

## Related

- [Durable commands](04-durable-commands.md): how the queue uses the store.
- [Connection and reconnect](01-connection-and-reconnect.md): `clientId`, which every persisted key starts with.
- [Errors and retries](08-errors-and-retries.md): what a refused entry carries.
