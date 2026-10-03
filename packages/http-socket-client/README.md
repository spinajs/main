# @spinajs/http-socket-client

Client for `@spinajs/http-socket`, for browsers and Node. It handles the connection state, reconnects with backoff, and offers commands with timeouts and cancellation, server events, stream replies with flow control, and typed contracts. Its only dependencies are `socket.io-client` and `@spinajs/http-socket-common`, which it re-exports.

A runnable server and client are in [`packages/http-socket-example`](../http-socket-example).

## Connect

```ts
import { SocketClient } from '@spinajs/http-socket-client';

const client = new SocketClient({
  url: 'https://app.example.com',
  clientId: storedClientId, // stable per install; generated when omitted
  auth: async () => ({ token: await tokens.current() }), // asked on every (re)connect
  reconnect: { minMs: 500, maxMs: 30_000, jitter: 0.3 }, // the defaults
  defaultTimeoutMs: 15_000, // the default
});
```

`storedClientId` and `tokens` stand for your own code. Other options: `path` (socket.io endpoint, `/socket.io` by default), `connectTimeoutMs` (20 s), `io` (passed to `socket.io-client`; reconnection, `autoConnect`, `forceNew`, `retries` and `auth` stay owned by the client) and `onListenerError`.

- The client connects on its own unless `autoConnect: false`.
- `client.state` is `'connecting' | 'online' | 'offline' | 'closed'`, and `client.on('state', (state, previous) => ...)` reports every change.
- `disconnect()` goes offline until `connect()`. `close()` is final: it rejects everything pending.

**Reconnect.** The client retries with exponential backoff and jitter, and asks `auth()` again on every attempt. It stops in these cases:

| Server answer | Lifecycle event |
|---|---|
| `unauthenticated` | `auth_required` |
| `version_mismatch` | `incompatible` |
| any other refusal with `retryable: false`, except `internal`, which is retried (`forbidden` for a foreign origin, `invalid_argument` ...) | `refused` |

`connect()` tries again. A `sys.shutdown { retryAfterMs }` notice delays the next attempt. A `sys.disconnect` whose reason is a non-retryable error code (the server sends `unauthenticated` for a revoked credential) stops the client in the same way.

## Commands

```ts
const doc = await client.command<OpenResult>('docs.open', { id }, { timeoutMs: 5_000, signal, whenOffline: 'wait' });
```

- `timeoutMs` covers the whole call. The server gets the remaining time as `deadline`.
- `whenOffline: 'fail'` (the default) rejects at once with `unavailable`. `'wait'` holds the command until the client is online or the timeout passes.
- Aborting `signal` sends `cancel`; the server's handler sees its own signal fire.
- A drop in the middle of a command rejects it with a retryable `unavailable`. Plain commands are never sent twice.
- Every rejection is a `SocketException` with `code`, `message`, `retryable` and, when the server sent them, `retryAfterMs`, `details` and `errorId`. Trust `retryable` and `retryAfterMs` when deciding to retry.

## Events

```ts
const off = client.on<Committed>('docs.committed', (payload) => apply(payload));
client.emit('docs.cursor', { x, y }); // fire-and-forget; false and dropped when not online
```

The lifecycle names (`state`, `auth_required`, `incompatible`, `refused`, `acked`, `failed`, `held`) are routed to the client's own listeners, so a server event with one of these names never reaches `on()`.

## Durable commands

```ts
import { SocketClient } from '@spinajs/http-socket-client';
import { IndexedDbOutboxStore } from '@spinajs/http-socket-client/browser'; // Node: FileOutboxStore from '/node'

const client = new SocketClient({ url, clientId: storedClientId, outbox: new IndexedDbOutboxStore('app') });
client.on('acked', ({ entry, result }) => {});
client.on('failed', ({ entry, error }) => {}); // refused for good; the entry waits in the store's failed list
await client.durable('docs.edit', { id, op }, { key: opId }).catch(() => undefined);
```

- The command is written to the outbox before it is sent, then sent in order, up to `durable.window` (16) at once, each with `after` set to the previous unacknowledged command. It carries no deadline. The server command must be `idempotent` and `ordered: 'client'`.
- After any drop everything unacknowledged is sent again, and so is a command unanswered for `durable.ackTimeoutMs` (60 s). Retryable errors are retried with the reconnect backoff.
- `unauthenticated` keeps the queue and emits `held`; nothing is sent until the connection comes online again.
- The key is your `key` (1 to 256 printable ASCII characters, not starting with `${clientId}:`) or a generated `${clientId}:<nonce>`.
- A persistent `outbox` requires an explicit `clientId`, stored by the app: a new random id after a reload would break exactly-once and ordering. The default `MemoryOutboxStore` does not survive a reload.
- `durable()` rejects when the server refuses the command for good and when the client closes (the entry stays in the outbox). Attach a `catch` or follow `acked` / `failed`.
- `acked` and `failed` fire in send order, also for entries resumed from the outbox after a reload.
- `FileOutboxStore` keeps payloads as JSON, so its `add` (and `durable()`) rejects with a `TypeError` a payload that a JSON round trip would change: `Uint8Array`, `Buffer`, `ArrayBuffer`, `Date`, `Map`, `Set`, class instances, `NaN`/`Infinity`, `undefined` inside an array. Nothing is written. Encode such values yourself (bytes as base64, dates as ISO strings). An `undefined` property is allowed: the wire drops it too. `IndexedDbOutboxStore` and `MemoryOutboxStore` keep binary.

## Streams

```ts
for await (const frame of client.stream<SnapshotFrame>('docs.snapshot', { docId }, { credits: 8 })) {
  apply(frame);
  if (cancelled) break; // sends cancel; the server generator's finally runs
}
```

- `stream()` returns an async iterator. The request goes out on the first `next()`. Calls to `next()` must not overlap.
- **Flow control.**
  - `credits` (default `DEFAULT_STREAM_CREDITS`, 8) is the most chunks that are ever in flight or buffered.
  - The client grants more as you read, in batches of at least half the window.
  - It must not exceed the server's `http.socket.streams.maxCredits` (64 by default). The server also refuses a window that, with what is granted but not yet used, goes over it.
- **Timeouts.** `timeoutMs` bounds the wait for the reply, and then each wait in `next()` for the next frame. A consumer that is slow to call `next()` is never timed out. The server ends a stream that gets no credit for its `streams.stallTimeoutMs`.
- **Failures.** On a server `fail`, a dropped connection (`unavailable`, retryable) or a closed client, the chunks already received are delivered first, then the iterator throws. Aborting `signal` drops buffered chunks, cancels the stream and throws `cancelled`.
- **Mismatches.** `stream()` on a command that answers a plain result throws `failed_precondition`, and so does `command()` on a stream command.
- **Resume.** The library does not resume streams. Put the position in the payload (for example `fromChunk`) and start a new stream after a retryable failure; with `whenOffline: 'wait'` it waits for the reconnect. `loadSnapshot` in [`packages/http-socket-example/src/client.ts`](../http-socket-example/src/client.ts) is a complete example.

## Typed contracts

One contract module, shared by the server and the client, types names and payloads:

```ts
import { defineContract } from '@spinajs/http-socket-client';

export type DocsContract = {
  commands: {
    'docs.open': [{ id: string }, { title: string }];
    'docs.snapshot': [{ docId: string; fromChunk?: number }, AsyncIterable<SnapshotFrame>];
  };
  events: { 'docs.committed': { seq: number } };
  clientEvents: { 'docs.cursor': { x: number; y: number } };
};

export const docsContract = defineContract<DocsContract>();

const docs = client.typed(docsContract);
const opened = await docs.command('docs.open', { id: 'a' }); // { title: string }
for await (const frame of docs.stream('docs.snapshot', { docId: 'a' })) {
} // frame: SnapshotFrame
docs.on('docs.committed', ({ seq }) => {});
```

Declare contracts with `type`, not `interface`. A stream command declares its result as `AsyncIterable<Item>`. The server side imports `defineContract` and the contract types from `@spinajs/http-socket-common` (or `@spinajs/http-socket`, which re-exports it); [`packages/http-socket-example/src/contract.ts`](../http-socket-example/src/contract.ts) is shared by both sides.

## Binary

`Uint8Array`, `ArrayBuffer` and `Buffer` anywhere in a payload travel as binary attachments and count toward the server's `maxPayloadBytes` by byte length. Binary results arrive as an `ArrayBuffer` in browsers and as a `Buffer` in Node; `new Uint8Array(result)` reads both.
