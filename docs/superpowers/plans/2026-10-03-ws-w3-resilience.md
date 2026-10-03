# W3 Resilience (idempotency, durable commands, graceful shutdown, recovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the spinajs WebSocket layer survive drops, restarts and overload without losing or repeating work: an `IdempotencyStore` and idempotency stage on the server, durable commands (outbox stores for memory, IndexedDB and file) on the client that run exactly once and in order, a graceful shutdown with a bounded drain, a `recovered` flag with a principal re-check on recovery, and a fault kit that proves it end to end.

**Architecture:** The server gets an `IdempotencyStore` (default `MemoryIdempotencyStore`, LRU + TTL) behind an injectable `SocketIdempotency` service, an `IdempotencyStage` at the reserved `STAGE_ORDER.Idempotency` (500), and an `after` fence inside the existing `OrderingStage`: a durable command names the idempotency key of the command sent before it, and runs only once that one has completed. The outcome of an ordered command is recorded inside its queue place, so the next command's fence always sees it. The client gets an `OutboxStore` interface and a `DurableQueue`, a new consumer of W2's `Connection` seams: it persists before sending, pipelines up to a window, resends everything unacknowledged after a drop, and settles callers in send order. `SocketServer.shutdown()` replaces W1's abrupt `dispose()`.

**Tech Stack:** TypeScript (ESM, `node16` resolution, dual mjs/cjs build), socket.io 4.8 / socket.io-client 4.8, `@spinajs/di` + `@spinajs/configuration`, `fake-indexeddb` 6 (client tests only), mocha + chai + chai-as-promised + sinon through `ts-mocha`.

**Spec:** `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md` (§5.2 step 5, §5.5, §6 durable commands and stores, §7 test matrix, §8 row W3). Consumer: `coderush/engine` `docs/superpowers/specs/2026-10-02-editor-server-sync-mcp-design.md` §6.1 (`doc.submit`, `blob.put` are durable, idempotent, client-ordered) and §7.3 (`IndexedDbOutboxStore`, the `failed` list, "human ops are never lost").

**Inputs absorbed:** W1 ledger DEFERRED items (shutdown drops `unavailable` replies; disconnect hooks unawaited after `Hub.detach`; recovery re-runs connect hooks without a flag; a serializing adapter flattens `Principal.identity`; idempotency keyed `(principalKey, clientId, key)` and independent of the dispatcher's running map; an abort releases the request id), `packages/http-socket/RELEASE_NOTES.md` "Notes for W3", and W2's reserved names (`durable()`, `failed`, `outbox`, `./browser`).

---

## Open questions (planned with the recommended default; none blocks execution)

1. **Wire protocol: `CommandRequest.after`.** Spec §6 asks for pipelining (window 16), resends after drops, retries after retryable errors, and server-side order. These four together are only safe if the server can tell that a command's predecessor has completed. Without that, a predecessor refused before the ordering stage (rate limit, a fence, a drop) lets its successor run first. For the editor this breaks `blob.put` before `doc.submit`.
   **Default:** add an optional `after?: string` (the predecessor's idempotency key) to `CommandRequest`, plus `MAX_KEY_LENGTH = 256` and `isKey()` in common. `PROTOCOL_VERSION` stays `1`, because nothing has shipped yet.
   *Alternative:* window 1, with no pipelining. It is simpler, but it puts one round trip on every human op.
2. **A durable command refused for good, and the commands after it.** Spec §6 step 4 moves it to the `failed` list and emits `failed`. It does not say whether the queue goes on.
   **Default:** the queue goes on. The server stores the final error as a completed outcome, so the next command's `after` fence passes. The editor resyncs the keys it wrote (§7.3).
   *Alternative:* pause the queue until the app acts. That needs a new `resume()` API.
3. **Results of entries resumed after a reload.** `durable()` promises do not survive a reload, so the app needs another way to learn about resumed entries.
   **Default:** add a lifecycle event `acked` `{ entry, result }`, emitted in send order for every acknowledged durable command, the resumed ones included. A server event named `acked` then becomes unreachable, as `failed` already is.
4. **Re-checking the principal on every recovered connection.** A session restored through a serializing adapter carries a JSON-flattened `Principal.identity`.
   **Default:** a recovered connection with a principal source is re-checked with that source before its connect hooks and commands run, whatever `revalidateMs` says. A `'valid'` answer that carries a principal replaces the flattened one. This costs one source call per recovery.
   *Alternative:* re-check only when `http.socket.adapter` is set. That saves the call on single-instance servers.

## Global Constraints

Every task's requirements include this section.

- **Repo / branch.** Work only in `C:\Users\grzch\SourceCodes\Spinajs\websocket-layer`, branch `feat/websocket-layer`, which has W1, W2 and `feat/authz-v3` merged. Never touch another Spinajs checkout or worktree.
- **Shared worktree.** Other agents work in this worktree: G1 in `packages/http-socket`, and possibly the W4 executor.
  - Stage only the exact paths a step names (`git add <paths>`, never `git add -A` or `git add .`).
  - Never run `git stash`, `git reset`, `git checkout -- …` or `git clean`.
  - Every commit command checks the branch in the same command: `test "$(git branch --show-current)" = feat/websocket-layer && git add … && git commit …`.
- **Lock file and release notes.** Never commit `package-lock.json`: `npm install` rewrites it, and you leave it modified. The integrator commits it. W3 writes its release notes only to `packages/http-socket/RELEASE_NOTES.md`, and X1 merges that file into the root one.
- **Versions.** `@spinajs/http-socket` stays `2.0.548`. `@spinajs/http-socket-common` and `@spinajs/http-socket-client` stay `3.0.0-alpha.0`, with exact internal pins.
- **Client runtime dependencies:** `socket.io-client` (`^4.8.1`) and `@spinajs/http-socket-common` (`3.0.0-alpha.0`) **only**. `fake-indexeddb` (`^6.0.0`) and `socket.io` are devDependencies.
- **The client's main entry and `./browser` run in browsers.** No Node built-in imports and no Node globals (`process`, `Buffer`, `require`, `__dirname`, `setImmediate`, `global`) anywhere in `packages/http-socket-client/src/`, except under `src/node/`, which only the `./node` subpath exports. `test/isomorphic.test.ts` enforces it (Task 12 teaches it the `src/node/` exception).
- **`http-socket-common` has zero runtime dependencies and is isomorphic.**
- **Error codes (exactly these 13):** `invalid_argument`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `failed_precondition`, `unimplemented`, `deadline_exceeded`, `cancelled`, `resource_exhausted`, `unavailable`, `version_mismatch`, `internal`. Retryability is common's `DEFAULT_RETRYABLE`, unless the thrower says otherwise.
- **Binding defaults, verbatim from the spec:**
  - `idempotency` `{ service: 'MemoryIdempotencyStore', ttlMs: 600_000 }` (10 min); W3 adds `maxEntries: 100_000`
  - `drainMs: 5_000`
  - durable `window: 16`
  - `recovery.maxDisconnectionMs: 120_000`
  - client reconnect `{ minMs: 500, maxMs: 30_000, jitter: 0.3 }`
  - `defaultTimeoutMs: 15_000`
- **Spec §5.2 step 5, verbatim:** "Idempotency (`idempotent: true` with an `idempotencyKey`): a completed key replays the stored reply; a running key awaits the same promise. The handler never runs twice for one `(clientId, key)`." W3 keys by `(principalKey, clientId, key)` (W1 release notes): a `clientId` is not a secret.
- **Spec §5.5 shutdown, verbatim:** "1. stop accepting connections; 2. emit `sys.shutdown {retryAfterMs}`; 3. let running commands finish for up to `drainMs` (5 s); 4. abort the rest with `unavailable`; 5. close."
- **Spec §6 durable, verbatim:** "1. A command is written to the `OutboxStore` before it is sent, with `idempotencyKey = clientId:<random nonce persisted with the entry>` (amended from `clientId:seq`; see `packages/http-socket/RELEASE_NOTES.md`, "W3 resilience (spec amendments)"). 2. Commands go out in order, pipelined up to a window (default 16). The server must declare the command `idempotent` and `ordered: 'client'`. 3. After any drop, everything not acked is resent in order. The server's idempotency store makes the resend safe. 4. On `ok`, the entry is removed. On a retryable error, it is retried with backoff. On a non-retryable error, it moves to the store's `failed` list and `failed` is emitted. The entry is never dropped silently. 5. The store survives reloads (IndexedDB), so a closed tab resumes its queue on the next start."
- **Spec §7 rows W3 must show:**
  - Idempotency: a replay of a finished key returns the stored reply, and concurrent replays run the handler once.
  - Ordering: `ordered: 'client'` runs a client's commands in send order across a reconnect.
  - **Durable:** 1 000 commands with the connection killed at random 100 times. Each runs **exactly once** on the server, and all resolve in order on the client.
  - Durable + reload: a client with an IndexedDB store, recreated mid-queue, finishes the queue.
  - Shutdown: running commands finish, new ones get `unavailable`, and the client reconnects to the restarted server and drains its durable queue.
  - Rooms: recovery replays the events missed in a 5 s drop.
- **`sys.shutdown` goes through `SocketConnection.notify()`.** `SocketHub` pushes refuse `sys.*` names, and `io.emit` would reach the clients of other instances when an adapter is set.
- **Wire names come from common's `WIRE_EVENTS` / `SYSTEM_EVENTS`.** No string literal for a wire event appears in `src/`.
- **Tests:** mocha + chai + chai-as-promised + sinon via `npx ts-mocha -p tsconfig.json test/<file>.test.ts`, run from inside the package.
  - Server tests run a real `SocketServer` on a random port (`test/harness.ts`).
  - Client tests run against `test/support/stub-server.ts`, never against the W1 server.
  - Only Task 13's e2e file uses the real server and the real client together.
  - Packages consume each other through built `lib/mjs`. After changing `http-socket-common/src`, run `npm run compile` in `packages/http-socket-common`. After changing `http-socket-client/src`, compile it too before running server e2e tests.
- **DI registry keys are class names.** Every test-only class (controllers, stores, sources, stages) gets a name that is unique across the whole package suite and is `export`ed. Connect and disconnect hooks run for every connection of every test file, so a hook must filter on its own `clientId`.
- **Windows:** a TCP connect to a closed localhost port takes about 2 s before it is refused. Restart tests allow for that in their timeouts and never assert on reconnect timing.
- **Code style:** English identifiers, comments and commit messages. Comment only a non-obvious "why". Follow the repo prettier config (`printWidth 1500`, single quotes, trailing commas). ESM imports with `.js` suffixes. Commits use `feat(http-socket): …`, `feat(http-socket-client): …`, `feat(http-socket-common): …`, `test(…)`, `docs(…)`.

## Decisions this plan takes where the spec is silent

- **D1. Store key.** `encodeURIComponent(principalKey) : encodeURIComponent(clientId) : encodeURIComponent(idempotencyKey)`. The encoding keeps the three parts unambiguous whatever characters they hold.
- **D2. Which outcomes are stored.** The outcome of a claimed key is classified by `SocketErrorMapper.toWire`, so a custom `@HandleSocketException` mapping decides retryability. The client retries exactly what the server released.

  | Outcome | What the store does |
  |---|---|
  | a result | stored |
  | a non-retryable error (including `internal`, `forbidden`, `invalid_argument` from policies or arguments) | stored; a replay throws `SocketException.fromWire(stored)`, so every reply carries the same `errorId` |
  | a retryable error | the key is released |
  | the call's own abort reason (deadline, cancel, disconnect, shutdown while queued) | the key is released; the command produced no outcome |
  | a stream result | the key is released; stream replies are not replayable (W4) |
- **D3. A key stays running until its handler settles,** even after the dispatcher has answered an abort. W1 keeps the request id released on abort (ledger note), and that stays as it is. The ordering stage's abort grace may cut a hung handler loose from its queue place. It then `detach`es the claim, and the key is recorded when the handler finally settles. A resend joins it and never runs it twice.
- **D4. The `after` fence lives in `OrderingStage`, at the head of the queue.** A request with `after` is refused with a retryable `unavailable` unless the store holds `after` as completed. `after` needs an `idempotencyKey` (`invalid_argument` otherwise) and an `ordered: 'client'` command (`failed_precondition` otherwise). An `idempotencyKey` sent to a command that is not `idempotent` is refused with `failed_precondition`, because the client would wrongly believe it is deduplicated.
- **D5. A running claim on another instance.** When the store says a key is running but this instance does not run it, the stage answers a retryable `unavailable` with `retryAfterMs: 1_000`. Joining across instances needs a shared store (Redis, ORM), which is not built here.
- **D6. Graceful shutdown.**
  - `SocketServer.shutdown()` is idempotent. `dispose()` calls it, and so does the `http.server.closing` DI event.
  - New handshakes, recovered sockets and new commands get `unavailable` with `retryAfterMs = http.socket.shutdownRetryAfterMs` (new key, default `5_000`).
  - The replies of commands aborted after `drainMs` are awaited (up to 1 s) before the sockets close. This fixes W1's dropped replies.
  - Disconnect hooks are awaited (up to `drainMs`) before `Hub.detach()`, so they can still push.
  - The test harness sets `drainMs: 0`, which keeps W1's tests as fast as before.
- **D7. Durable client details.**
  - `idempotencyKey` is `clientId:<random nonce persisted with the entry>` (see `packages/http-socket/RELEASE_NOTES.md`, "W3 resilience (spec amendments)"), or an app key passed as `durable(name, payload, { key })`; the editor uses opIds.
  - Durable requests carry no `deadline`.
  - An entry unanswered for `ackTimeoutMs` (default 60 s) on a live connection is resent; the server joins or replays it.
  - `unauthenticated` keeps the entry queued, because it is the credential that failed, not the command. W2's kick handling emits `auth_required`.
  - Retryable errors pause the whole queue with W2's `ReconnectPolicy` backoff, which honours `retryAfterMs`.
  - `close()` rejects waiting callers with a non-retryable `unavailable` ("the command stays in the outbox"), and the entries stay in the store.
  - `refused`, `auth_required` and `incompatible` leave the queue untouched: nothing is sent until the app calls `connect()`.
- **D8. Store contract.** Every `OutboxStore` method resolves only once its change is durable. `seq` is assigned by the store, strictly increases and is never reused. A store serves one `SocketClient` at a time.
  - `IndexedDbOutboxStore` uses IndexedDB `autoIncrement` and `durability: 'strict'`.
  - `FileOutboxStore` rewrites one JSON file through a temp file, `fsync` and `rename`.
  - `FileOutboxStore` ships under the `./node` subpath, so the main entry stays isomorphic.

## Known limits (documented in Task 14, not fixed here)

- `MemoryIdempotencyStore` gives exactly-once across disconnects and across a *graceful* restart: the drain flushes every reply. It does not after a crash, or after an ack is lost and the server then restarts: the store is empty and the resend runs again. A persistent store (ORM, Redis) closes this. The editor additionally deduplicates by `opId` in its op log (§7.1).
- A completed key is forgotten after `ttlMs` (10 min). A client that stays offline longer, with an unacknowledged entry, runs it again on resend.
- `ordered: 'client'` queues and the fence are per instance. Several instances need sticky sessions.

## File map

`packages/http-socket-common/`

| File | Change |
|---|---|
| `src/protocol.ts` | `MAX_KEY_LENGTH`, `isKey()`, `CommandRequest.after`; `isCommandRequest` checks both keys with `isKey` (Task 1) |
| `test/common.test.ts` | key and `after` cases (Task 1) |

`packages/http-socket/`

| File | Change |
|---|---|
| `src/idempotency.ts` (new) | `IdempotencyStore`, `IdempotencyRecord`, `MemoryIdempotencyStore`, `assertIdempotencyConfig` (Task 3); `SocketIdempotency` (Task 4) |
| `src/stages/idempotency.ts` (new) | `IdempotencyStage` at 500 (Task 4) |
| `src/stages/index.ts` | export the stage (Task 4) |
| `src/stages/ordering.ts` | outcome recorded inside the queue place, `detach` on cut-loose, `after` fence (Task 5) |
| `src/interfaces.ts` | `ISocketIdempotencyConfig.maxEntries`, `ISocketServerConfig.shutdownRetryAfterMs` (Tasks 3, 6); `CommandOutcome`, `IdempotentReply`, `ISocketIdempotencyClaim`, `ISocketCommandContext.idempotency` (Task 4) |
| `src/context.ts` | `idempotency?` field (Task 4) |
| `src/config/http-socket.ts` | `idempotency.maxEntries`, `shutdownRetryAfterMs` (Tasks 3, 6) |
| `src/limits.ts` | `assertShutdownConfig` (Task 6) |
| `src/dispatcher.ts` | `refuseNew`, `drained`, `hooksDone`, reply and hook tracking (Task 6); re-check of recovered connections before their hooks (Task 7) |
| `src/server.ts` | config checks (Tasks 3, 6), `shutdown()`, `closing` refusals, `http.server.closing` (Task 6) |
| `src/connection.ts` | `recovered` (Task 7) |
| `src/principal-guard.ts` | `recheck()` (Task 7) |
| `src/index.ts` | export the idempotency API (Tasks 3, 4) |
| `package.json` | devDependency `@spinajs/http-socket-client` (Task 13) |
| `RELEASE_NOTES.md` | W3 sections (Task 14) |
| `test/harness.ts` | `startServer(cfg, prepare, port)` (Task 2); `drainMs: 0` in the test config (Task 6) |
| `test/faults.ts` (new) | fault kit: `killConnections`, `killConnection`, `ackFaults` + `FaultKitStage`, `restart` (Task 2) |
| `test/faults.test.ts` (new) | the kit's own tests (Task 2) |
| `test/idempotency-store.test.ts` (new) | store and config (Task 3) |
| `test/idempotency.test.ts` (new) | stage behaviour (Task 4) |
| `test/durable-order.test.ts` (new) | the `after` fence (Task 5) |
| `test/shutdown.test.ts` (new) | graceful shutdown (Task 6) |
| `test/recovery.test.ts` | `recovered`, re-check, identity (Task 7) |
| `test/durable-e2e.test.ts` (new) | §7 Durable, Shutdown, Rooms rows with the real client (Task 13) |
| `test/config.test.ts`, `test/exports.test.ts` | new defaults and exports (Tasks 1, 3, 4, 6) |

`packages/http-socket-client/`

| File | Change |
|---|---|
| `src/outbox.ts` (new) | `OutboxStore`, `OutboxEntry`, `FailedOutboxEntry`, `OutboxInput`, `MemoryOutboxStore` (Task 8) |
| `src/durable.ts` (new) | `DurableQueue`, `DurableOptions`, `DurableCommandOptions`, `DEFAULT_DURABLE`, `AckedCommand`, `FailedCommand` (Task 9) |
| `src/client.ts`, `src/contract.ts`, `src/index.ts` | `outbox` / `durable` options, `durable()`, lifecycle `acked` + typed `failed` (Task 10) |
| `src/outbox-indexeddb.ts` (new), `src/browser.ts` (new) | `IndexedDbOutboxStore`, `./browser` entry (Task 11) |
| `src/node/file-outbox.ts` (new), `src/node/index.ts` (new) | `FileOutboxStore`, `./node` entry (Task 12) |
| `package.json` | `./browser` + `./node` exports, devDependency `fake-indexeddb` (Tasks 11, 12) |
| `test/support/outbox-contract.ts` (new) | shared `OutboxStore` contract suite (Task 8) |
| `test/support/durable.ts` (new) | `serveDurable` stub behaviour + `onlineQueue` helper (Task 9) |
| `test/outbox.test.ts`, `test/durable.test.ts`, `test/durable-client.test.ts`, `test/indexeddb-outbox.test.ts`, `test/file-outbox.test.ts` (new) | Tasks 8–12 |
| `test/client.test.ts`, `test/index.test.ts`, `test/isomorphic.test.ts` | durable no longer reserved; exports; `src/node/` exception (Tasks 10, 12) |

## Task boundaries and parallelism

- **Inside W3.** Task 1 (common) goes first. After it, two lanes can run in parallel worktrees, because they share no file:
  - **server lane:** Tasks 2 → 3 → 4 → 5 → 6 → 7, only `packages/http-socket`
  - **client lane:** Tasks 8 → 9 → 10 → 11 → 12, only `packages/http-socket-client`

  Task 13 needs both lanes. Task 14 comes last.
- **Against G1** (running now in `packages/http-socket`). G1 edits `src/interfaces.ts` (`ISocketCallStorage`), maybe `test/harness.ts` (`TestConfiguration.onLoad`), and `RELEASE_NOTES.md`. Start the server lane after G1 has committed. Tasks 2, 3, 4 and 6 edit those files in other hunks.
- **Against W4** (`docs/superpowers/plans/2026-10-03-ws-w4-streams.md`). Both plans build on W1 + W2. These files are likely touched by both:

  | File | W3 change | Likely W4 change |
  |---|---|---|
  | `http-socket-common/src/protocol.ts`, `test/common.test.ts` | `after`, `MAX_KEY_LENGTH`, `isKey` (Task 1) | stream frame guards |
  | `http-socket/src/dispatcher.ts` | `refuseNew` / `drained` / `hooksDone`, tracking, recovered re-check (Tasks 6, 7) | the `toReply` stream branch, frames |
  | `http-socket/src/interfaces.ts` | claim types and config fields | stream options |
  | `http-socket/src/config/http-socket.ts`, `test/config.test.ts` | new keys | stream keys |
  | `http-socket/src/index.ts`, `test/exports.test.ts` | idempotency exports | stream exports |
  | `http-socket/package.json` | devDependency on the client (Task 13) | likely the same, for stream e2e |
  | `http-socket/RELEASE_NOTES.md` | W3 section | W4 section |
  | `http-socket-client/src/client.ts`, `src/contract.ts`, `src/index.ts`, `test/index.test.ts` | `durable()` | `stream()` |
  | `http-socket-client/test/client.test.ts` | the "reserves durable() and stream()" test keeps only `stream()` (Task 10) | removes it |
  | `http-socket-client/package.json` | `./browser`, `./node`, `fake-indexeddb` | none expected |

  W3 does **not** edit `http-socket-client/test/support/stub-server.ts`: Task 9 plugs durable behaviour in through the stub's existing `rawReplies` hook, so W4 owns that file.
- **Running W3 and W4 side by side.** Run them in separate worktrees and merge W3 first. The conflicts above are small additive hunks; W4 rebases onto W3. Run them in sequence in this shared worktree only if one plan has finished.

---

### Task 1: Protocol — idempotency key rules and `after`

**Files:**
- Modify: `packages/http-socket-common/src/protocol.ts`, in three places: after `NAME_PATTERN`, the `CommandRequest` interface, and `isCommandRequest`
- Test: `packages/http-socket-common/test/common.test.ts` (new `it` blocks inside `describe('envelope guards')`)
- Modify: `packages/http-socket/test/exports.test.ts`. The server re-exports common, so its snapshot gains two names.

**Interfaces:**
- Consumes: `ID_PATTERN`, `isId` (common, existing).
- Produces:
  - `export const MAX_KEY_LENGTH = 256`
  - `export function isKey(value: unknown): value is string`: 1–256 printable ASCII characters (`ID_PATTERN`)
  - `CommandRequest.after?: string`: the idempotency key of the durable command this one must follow
  - `isCommandRequest` refuses an `idempotencyKey` or an `after` that fails `isKey`

- [ ] **Step 1: Write the failing tests**

In `packages/http-socket-common/test/common.test.ts`, add `MAX_KEY_LENGTH` and `isKey` to the names imported from `'../src/index.js'`. Then add these two tests at the end of `describe('envelope guards', …)`, after `it('checks event and cancel frames', …)`:

```ts
    it('accepts idempotency keys and after of 1-MAX_KEY_LENGTH printable ASCII characters', () => {
      const longest = 'k'.repeat(MAX_KEY_LENGTH);
      expect(MAX_KEY_LENGTH).to.equal(256);

      for (const key of ['client-1:1', `${'c'.repeat(128)}:9007199254740991`, longest, '550e8400-e29b-41d4-a716-446655440000']) {
        expect(isKey(key), key).to.be.true;
        expect(isCommandRequest({ id: 'r1', name: 'x', idempotencyKey: key, after: key }), key).to.be.true;
      }

      for (const key of ['', longest + 'k', 'a b', 'a\n', '\u017c', 5, null]) {
        expect(isKey(key), JSON.stringify(key)).to.be.false;
        expect(isCommandRequest({ id: 'r1', name: 'x', idempotencyKey: key }), JSON.stringify(key)).to.be.false;
        expect(isCommandRequest({ id: 'r1', name: 'x', idempotencyKey: 'k1', after: key }), JSON.stringify(key)).to.be.false;
      }
    });

    it('accepts a request without after, and after without a key ( the server refuses that one )', () => {
      expect(isCommandRequest({ id: 'r1', name: 'x', idempotencyKey: 'k1' })).to.be.true;
      expect(isCommandRequest({ id: 'r1', name: 'x', after: 'k0' })).to.be.true;
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: FAIL to compile with `Module '"../src/index.js"' has no exported member 'MAX_KEY_LENGTH'` (and the same for `'isKey'`).

- [ ] **Step 3: Implement**

In `packages/http-socket-common/src/protocol.ts`, insert after the `NAME_PATTERN` constant:

```ts
/** Longest accepted idempotency key: a clientId ( MAX_ID_LENGTH ), a separator and a nonce fit. */
export const MAX_KEY_LENGTH = 256;
```

Replace the `CommandRequest` interface with:

```ts
export interface CommandRequest<P = unknown> {
  id: string;
  name: string;
  payload: P;
  /** Deduplicates the command on the server; printable ASCII, at most MAX_KEY_LENGTH characters. */
  idempotencyKey?: string;
  /**
   * Durable commands: the idempotency key of the command sent before this one. The server runs this
   * one only after that one has completed, and otherwise refuses it with a retryable `unavailable`.
   */
  after?: string;
  /**
   * Milliseconds the caller is still willing to wait, measured from when the request was sent.
   * Relative on purpose: client and server clocks never have to agree.
   */
  deadline?: number;
  traceparent?: string;
}
```

Insert after `isName`:

```ts
export function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_KEY_LENGTH && ID_PATTERN.test(value);
}
```

Replace `isCommandRequest` with:

```ts
export function isCommandRequest(value: unknown): value is CommandRequest {
  if (!isRecord(value)) {
    return false;
  }

  return isId(value.id) && isName(value.name) && (value.idempotencyKey === undefined || isKey(value.idempotencyKey)) && (value.after === undefined || isKey(value.after)) && (value.deadline === undefined || (typeof value.deadline === 'number' && Number.isFinite(value.deadline))) && (value.traceparent === undefined || typeof value.traceparent === 'string');
}
```

- [ ] **Step 4: Run the tests and build common**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts && npm run compile`
Expected: `17 passing`, then `tsc -b` with no output.

- [ ] **Step 5: Update the server's export snapshot**

In `packages/http-socket/test/exports.test.ts`, edit `PUBLIC_API`:
- insert `'MAX_KEY_LENGTH',` between `'MAX_ID_LENGTH',` and `'MAX_NAME_LENGTH',`
- insert `'isKey',` between `'isId',` and `'isName',`

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/exports.test.ts`
Expected: `3 passing`.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-common/src/protocol.ts packages/http-socket-common/test/common.test.ts packages/http-socket/test/exports.test.ts && \
git commit -m "feat(http-socket-common): idempotency key rules and the after field of durable commands"
```

---

### Task 2: Server fault kit and restart on the same port

**Files:**
- Modify: `packages/http-socket/test/harness.ts` (`startServer` gains a `port` parameter)
- Create: `packages/http-socket/test/faults.ts`
- Test: `packages/http-socket/test/faults.test.ts`

**Interfaces:**
- Consumes: `startServer`, `ITestServer`, `delay`, `open`, `command`, `resultOf` from `test/harness.ts`; `SocketServer.Io`; `SocketCommandStage`.
- Produces (test-only; Tasks 4–7 and 13 use them):
  - `startServer(cfg?: Record<string, unknown>, prepare?: (host: TestHttpHost) => void, port = 0): Promise<ITestServer>`
  - `killConnections(t: ITestServer): number`: closes every engine.io connection without a socket.io DISCONNECT, as a network drop does, so connection state recovery may restore them. Returns how many it closed.
  - `killConnection(t: ITestServer, connectionId: string): boolean`
  - `ackFaults: { drop: number; delayMs: number; reset(): void }`:
    - `drop = n` kills the transport of the next `n` commands right after their handler settled, so their reply is lost.
    - `delayMs` holds every reply that long.
  - `class FaultKitStage extends SocketCommandStage`: Order 10, registered for every test server, and a no-op while `ackFaults` is reset.
  - `restart(t: ITestServer, cfg?: Record<string, unknown>, downMs = 0): Promise<ITestServer>`: runs `t.close()`, which runs the server's shutdown, then starts a fresh DI cache and server on the same port.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket/test/faults.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AddressInfo } from 'net';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { ITestServer, command, open, resultOf, startServer } from './harness.js';
import { ackFaults, killConnection, killConnections, restart } from './faults.js';

export const faultRuns: string[] = [];

@SocketController('fault')
export class FaultKitSocket extends BaseSocketController {
  @Command('touch')
  public async touch() {
    faultRuns.push('touch');
    return 'touched';
  }
}

const closed = (socket: ClientSocket) => new Promise<string>((resolve) => socket.once('disconnect', (reason) => resolve(reason)));

describe('server fault kit', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  beforeEach(async () => {
    faultRuns.length = 0;
    t = await startServer();
  });

  afterEach(async () => {
    ackFaults.reset();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  const connect = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  it('kills every engine connection as a network drop does', async () => {
    const a = await connect('fault-a');
    const b = await connect('fault-b');
    const drops = [closed(a), closed(b)];

    expect(killConnections(t)).to.equal(2);
    expect(await Promise.all(drops)).to.deep.equal(['transport close', 'transport close']);
  });

  it('kills one connection by id', async () => {
    const a = await connect('fault-one');
    const drop = closed(a);

    expect(killConnection(t, a.id!)).to.be.true;
    expect(await drop).to.equal('transport close');
    expect(killConnection(t, 'no-such-id')).to.be.false;
  });

  it('drops the reply of a command whose handler ran', async () => {
    const a = await connect('fault-drop');
    ackFaults.drop = 1;
    const drop = closed(a);

    await expect(command(a, 'fault.touch')).to.be.rejected;
    await drop;
    expect(faultRuns).to.deep.equal(['touch']);
    expect(ackFaults.drop).to.equal(0);
  });

  it('delays replies', async () => {
    const a = await connect('fault-delay');
    ackFaults.delayMs = 200;
    const started = Date.now();

    expect(resultOf(await command(a, 'fault.touch'))).to.equal('touched');
    expect(Date.now() - started).to.be.at.least(190);
  });

  it('restarts the server on the same port', async () => {
    const { port } = t.host.Http.address() as AddressInfo;
    t = await restart(t);

    expect((t.host.Http.address() as AddressInfo).port).to.equal(port);
    const a = await connect('fault-restart');
    expect(resultOf(await command(a, 'fault.touch'))).to.equal('touched');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/faults.test.ts`
Expected: FAIL with `Cannot find module './faults.js'`.

- [ ] **Step 3: Give `startServer` a port**

In `packages/http-socket/test/harness.ts`, replace the doc comment and signature of `startServer`:

```ts
/**
 * @param prepare - runs on the fresh http server before socket.io attaches to it
 * @param port - 0 picks a free port; the fault kit's restart passes the previous one
 */
export async function startServer(cfg: Record<string, unknown> = {}, prepare?: (host: TestHttpHost) => void, port = 0): Promise<ITestServer> {
```

and its `listen` line:

```ts
  await new Promise<void>((resolve) => host.Http.listen(port, '127.0.0.1', () => resolve()));
```

- [ ] **Step 4: Write the fault kit**

Create `packages/http-socket/test/faults.ts`:

```ts
import { AddressInfo } from 'net';
import { DI, Injectable } from '@spinajs/di';
import { ISocketCommandContext, SocketCommandStage } from '../src/interfaces.js';
import { SocketServer } from '../src/server.js';
import { ITestServer, delay, startServer } from './harness.js';

/** Closes every engine.io connection without a socket.io DISCONNECT, as a network drop does; recovery may restore them. */
export function killConnections(t: ITestServer): number {
  const sockets = [...(t.server.Io?.of('/').sockets.values() ?? [])];
  sockets.forEach((socket) => socket.conn.close());
  return sockets.length;
}

export function killConnection(t: ITestServer, connectionId: string): boolean {
  const socket = t.server.Io?.of('/').sockets.get(connectionId);
  socket?.conn.close();
  return socket !== undefined;
}

export const ackFaults = {
  /** the next `drop` commands lose their reply: the transport is killed right after the handler settled */
  drop: 0,
  /** every reply waits this long */
  delayMs: 0,
  reset(): void {
    this.drop = 0;
    this.delayMs = 0;
  },
};

/** Outermost stage of every test server; does nothing while `ackFaults` is reset. */
@Injectable(SocketCommandStage)
export class FaultKitStage extends SocketCommandStage {
  public get Order(): number {
    return 10;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    try {
      return await next();
    } finally {
      if (ackFaults.delayMs > 0) {
        await delay(ackFaults.delayMs);
      }

      if (ackFaults.drop > 0) {
        ackFaults.drop--;
        DI.get(SocketServer)?.Io?.of('/').sockets.get(ctx.connection.id)?.conn.close();
      }
    }
  }
}

/** Runs the server's shutdown, then starts a fresh one on the same port; memory stores are lost, as in a real restart. */
export async function restart(t: ITestServer, cfg: Record<string, unknown> = {}, downMs = 0): Promise<ITestServer> {
  const { port } = t.host.Http.address() as AddressInfo;
  await t.close();

  if (downMs > 0) {
    await delay(downMs);
  }

  return startServer(cfg, undefined, port);
}
```

- [ ] **Step 5: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/faults.test.ts`
Expected: `5 passing`.

Then run the whole package suite once, to confirm that the stage, registered for every server, changes nothing while it is a no-op: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npm test`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/test/harness.ts packages/http-socket/test/faults.ts packages/http-socket/test/faults.test.ts && \
git commit -m "test(http-socket): fault kit: kill connections, drop or delay replies, restart on the same port"
```

---

### Task 3: `IdempotencyStore` and `MemoryIdempotencyStore`

**Files:**
- Create: `packages/http-socket/src/idempotency.ts`
- Modify: `packages/http-socket/src/interfaces.ts` (`ISocketIdempotencyConfig`, plus the claim types below)
- Modify: `packages/http-socket/src/config/http-socket.ts` (`idempotency.maxEntries`)
- Modify: `packages/http-socket/src/server.ts` (`resolve()` checks the idempotency config)
- Modify: `packages/http-socket/src/index.ts`, `packages/http-socket/test/exports.test.ts`, `packages/http-socket/test/config.test.ts`
- Test: `packages/http-socket/test/idempotency-store.test.ts`

**Interfaces:**
- Consumes: `SocketError` (common).
- Produces:
  - `type IdempotentReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: SocketError }`, in `interfaces.ts`. Task 4 uses it.
  - `type IdempotencyRecord = { readonly state: 'running' } | { readonly state: 'done'; readonly reply: IdempotentReply }`
  - `abstract class IdempotencyStore`:
    - `claim(key: string): Promise<IdempotencyRecord | null>`: atomically claims a free key and returns `null`, or returns the record that already holds it
    - `complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void>`
    - `release(key: string): Promise<void>`: drops a running claim; never a completed one
    - `get(key: string): Promise<IdempotencyRecord | null>`
  - `@Injectable(IdempotencyStore) class MemoryIdempotencyStore`, with `constructor(options?: Partial<ISocketIdempotencyConfig>, now?: () => number)` and the getter `Size: number`
  - `function assertIdempotencyConfig(options: ISocketIdempotencyConfig): void` (internal; not exported from the index)
  - `ISocketIdempotencyConfig { service: string; ttlMs: number; maxEntries: number }`
- `@AutoinjectService('http.socket.idempotency', IdempotencyStore)` resolves the store class whose name is `service`, and passes the whole `http.socket.idempotency` object as the first constructor argument. `MemoryIdempotencyStore` reads `maxEntries` from it.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket/test/idempotency-store.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { IdempotencyStore, MemoryIdempotencyStore, assertIdempotencyConfig } from '../src/idempotency.js';
import type { IdempotentReply } from '../src/interfaces.js';

const OK: IdempotentReply = { ok: true, result: { n: 1 } };
const FAILED: IdempotentReply = { ok: false, error: { code: 'conflict', message: 'taken', retryable: false } };

function clocked(maxEntries = 100) {
  const clock = { now: 1_000 };
  const store = new MemoryIdempotencyStore({ maxEntries }, () => clock.now);
  return { store, clock };
}

describe('MemoryIdempotencyStore', () => {
  it('is an IdempotencyStore', () => {
    expect(new MemoryIdempotencyStore()).to.be.instanceOf(IdempotencyStore);
  });

  it('claims a free key once; later claims see it running', async () => {
    const { store } = clocked();

    expect(await store.claim('k')).to.be.null;
    expect(await store.claim('k')).to.deep.equal({ state: 'running' });
    expect(await store.get('k')).to.deep.equal({ state: 'running' });
  });

  it('keeps a completed reply, for claims and gets, until its TTL passes', async () => {
    const { store, clock } = clocked();
    await store.claim('k');
    await store.complete('k', OK, 500);

    expect(await store.claim('k')).to.deep.equal({ state: 'done', reply: OK });
    clock.now += 499;
    expect(await store.get('k')).to.deep.equal({ state: 'done', reply: OK });
    clock.now += 1;
    expect(await store.get('k')).to.be.null;
    expect(await store.claim('k')).to.be.null;
  });

  it('keeps final errors like results', async () => {
    const { store } = clocked();
    await store.claim('k');
    await store.complete('k', FAILED, 500);

    expect(await store.get('k')).to.deep.equal({ state: 'done', reply: FAILED });
  });

  it('releases a running claim but never a completed one', async () => {
    const { store } = clocked();
    await store.claim('running');
    await store.claim('done');
    await store.complete('done', OK, 500);

    await store.release('running');
    await store.release('done');
    await store.release('unknown');

    expect(await store.get('running')).to.be.null;
    expect(await store.get('done')).to.deep.equal({ state: 'done', reply: OK });
  });

  it('evicts the least recently used completed keys over maxEntries, never a running claim', async () => {
    const { store } = clocked(2);
    await store.claim('busy');
    for (const key of ['a', 'b']) {
      await store.claim(key);
      await store.complete(key, OK, 10_000);
    }

    // touching 'a' makes 'b' the least recently used completed key
    await store.get('a');
    await store.claim('c');
    await store.complete('c', OK, 10_000);

    expect(await store.get('busy')).to.deep.equal({ state: 'running' });
    expect(await store.get('b')).to.be.null;
    expect(await store.get('a')).to.not.be.null;
    expect(await store.get('c')).to.not.be.null;
    expect(store.Size).to.equal(3);
  });

  it('drops expired keys on the way when it evicts', async () => {
    const { store, clock } = clocked(10);
    await store.claim('old');
    await store.complete('old', OK, 100);
    clock.now += 200;
    await store.claim('new');
    await store.complete('new', OK, 100);

    expect(store.Size).to.equal(1);
  });
});

describe('http.socket.idempotency checks', () => {
  it('refuses a missing service, a non-positive TTL and a non-integer or non-positive maxEntries', () => {
    const good = { service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 };
    expect(() => assertIdempotencyConfig(good)).not.to.throw();

    for (const bad of [{ ...good, service: '' }, { ...good, ttlMs: 0 }, { ...good, ttlMs: Number.NaN }, { ...good, ttlMs: 2 ** 31 }, { ...good, maxEntries: 0 }, { ...good, maxEntries: 1.5 }]) {
      expect(() => assertIdempotencyConfig(bad), JSON.stringify(bad)).to.throw(RangeError);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/idempotency-store.test.ts`
Expected: FAIL with `Cannot find module '../src/idempotency.js'`.

- [ ] **Step 3: Add the config field and the reply type**

In `packages/http-socket/src/interfaces.ts`:

1. Replace `ISocketIdempotencyConfig` with:

   ```ts
   export interface ISocketIdempotencyConfig {
     /** Class name of the IdempotencyStore implementation; this whole object is its first constructor argument. */
     service: string;
     /** How long a completed key replays its reply. */
     ttlMs: number;
     /** MemoryIdempotencyStore: completed keys kept at most; the least recently used go first. */
     maxEntries: number;
   }
   ```

2. Change the existing type import `import type { CommandRequest } from '@spinajs/http-socket-common';` to `import type { CommandRequest, SocketError } from '@spinajs/http-socket-common';`.

3. Append at the end of the file:

   ```ts
   /** What an idempotent command replays: its result, or the error it failed with for good. */
   export type IdempotentReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: SocketError };
   ```

In `packages/http-socket/src/config/http-socket.ts`, replace the `idempotency` block with:

```ts
      idempotency: {
        service: 'MemoryIdempotencyStore',
        ttlMs: 600_000,
        maxEntries: 100_000,
      },
```

- [ ] **Step 4: Write the store**

Create `packages/http-socket/src/idempotency.ts`:

```ts
import { Injectable } from '@spinajs/di';
import type { IdempotentReply, ISocketIdempotencyConfig } from './interfaces.js';

const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_ENTRIES = 100_000;

export type IdempotencyRecord = { readonly state: 'running' } | { readonly state: 'done'; readonly reply: IdempotentReply };

/**
 * Remembers the outcome of idempotent commands by one key per principal, clientId and idempotency key.
 * A store shared by several instances ( Redis, ORM ) must make `claim` atomic, and should expire the
 * running claims of an instance that died.
 */
export abstract class IdempotencyStore {
  /** Claims a free key as running and returns null, or returns the record that already holds it; atomic. */
  public abstract claim(key: string): Promise<IdempotencyRecord | null>;

  public abstract complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void>;

  /** Drops a running claim whose command produced no outcome, so a resend runs it again; never a completed key. */
  public abstract release(key: string): Promise<void>;

  public abstract get(key: string): Promise<IdempotencyRecord | null>;
}

interface IMemoryEntry {
  record: IdempotencyRecord;
  expiresAt: number;
}

/** Process memory: exactly-once across disconnects and graceful restarts, not across crashes. */
@Injectable(IdempotencyStore)
export class MemoryIdempotencyStore extends IdempotencyStore {
  protected entries = new Map<string, IMemoryEntry>();
  protected maxEntries: number;

  constructor(options: Partial<ISocketIdempotencyConfig> = {}, protected now: () => number = () => Date.now()) {
    super();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  public get Size(): number {
    return this.entries.size;
  }

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    const held = this.lookup(key);
    if (held) {
      return held;
    }

    this.entries.set(key, { record: { state: 'running' }, expiresAt: Number.POSITIVE_INFINITY });
    return null;
  }

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    // re-inserted: Map order is the LRU order
    this.entries.delete(key);
    this.entries.set(key, { record: { state: 'done', reply }, expiresAt: this.now() + ttlMs });
    this.evict();
  }

  public async release(key: string): Promise<void> {
    if (this.entries.get(key)?.record.state === 'running') {
      this.entries.delete(key);
    }
  }

  public async get(key: string): Promise<IdempotencyRecord | null> {
    return this.lookup(key);
  }

  protected lookup(key: string): IdempotencyRecord | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    if (entry.record.state === 'done') {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    return entry.record;
  }

  protected evict(): void {
    const now = this.now();
    let done = [...this.entries.values()].filter((e) => e.record.state === 'done').length;

    for (const [key, entry] of this.entries) {
      if (entry.record.state === 'running') {
        continue;
      }

      if (done <= this.maxEntries && entry.expiresAt > now) {
        // under the cap: the remaining expired keys go lazily, on lookup
        break;
      }

      this.entries.delete(key);
      done--;
    }
  }
}

export function assertIdempotencyConfig(options: ISocketIdempotencyConfig): void {
  if (!(typeof options?.service === 'string' && options.service.length > 0)) {
    throw new RangeError(`http.socket.idempotency.service must name an IdempotencyStore class, got ${JSON.stringify(options?.service)}`);
  }

  if (!(typeof options.ttlMs === 'number' && options.ttlMs > 0 && options.ttlMs <= MAX_TIMER_MS)) {
    throw new RangeError(`http.socket.idempotency.ttlMs must be within (0, ${MAX_TIMER_MS}], got ${String(options.ttlMs)}`);
  }

  if (!(Number.isInteger(options.maxEntries) && options.maxEntries > 0)) {
    throw new RangeError(`http.socket.idempotency.maxEntries must be an integer above 0, got ${String(options.maxEntries)}`);
  }
}
```

The `evict()` loop counts only completed entries against `maxEntries`, so running claims never push a completed key out early. It walks from the least recently used end. It deletes while the count is over the cap, or while it meets expired keys. It stops at the first live entry once under the cap, so it does not scan the whole map.

- [ ] **Step 5: Check the config at startup and export the API**

In `packages/http-socket/src/server.ts`:
- add `import { assertIdempotencyConfig } from './idempotency.js';`
- in `resolve()`, right after `await super.resolve();`, add `assertIdempotencyConfig(this.Options.idempotency);`

In `packages/http-socket/src/index.ts`, add after the `limits.js` export line:

```ts
export { IdempotencyStore, MemoryIdempotencyStore } from './idempotency.js';
export type { IdempotencyRecord } from './idempotency.js';
```

In `packages/http-socket/test/exports.test.ts`:
- insert `'IdempotencyStore',` between `'IN_FLIGHT_RETRY_AFTER_MS',` and `'InFlightStage',`
- insert `'MemoryIdempotencyStore',` between `'MAX_NAME_LENGTH',` and `'NAME_PATTERN',`

In `packages/http-socket/test/config.test.ts`, replace the idempotency line with:

```ts
    expect(socket.idempotency).to.deep.equal({ service: 'MemoryIdempotencyStore', ttlMs: 600_000, maxEntries: 100_000 });
```

- [ ] **Step 6: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/idempotency-store.test.ts test/exports.test.ts test/config.test.ts test/pipeline.test.ts`
Expected: `0 failing`. The two new describe blocks contribute `8 passing`.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/idempotency.ts packages/http-socket/src/interfaces.ts packages/http-socket/src/config/http-socket.ts packages/http-socket/src/server.ts packages/http-socket/src/index.ts packages/http-socket/test/idempotency-store.test.ts packages/http-socket/test/exports.test.ts packages/http-socket/test/config.test.ts && \
git commit -m "feat(http-socket): IdempotencyStore with an in-memory LRU and TTL default"
```

---

### Task 4: `IdempotencyStage` (pipeline step 5) and `SocketIdempotency`

**Files:**
- Modify: `packages/http-socket/src/idempotency.ts` (append `SocketIdempotency`)
- Create: `packages/http-socket/src/stages/idempotency.ts`
- Modify: `packages/http-socket/src/stages/index.ts`, `packages/http-socket/src/interfaces.ts`, `packages/http-socket/src/context.ts`, `packages/http-socket/src/index.ts`, `packages/http-socket/test/exports.test.ts`
- Test: `packages/http-socket/test/idempotency.test.ts`

**Interfaces:**
- Consumes: `IdempotencyStore`, `IdempotencyRecord`, `IdempotentReply` (Task 3); `SocketErrorMapper.toWire(err, context)`; `untilAborted` (`limits.ts`); `principalKey` (`@spinajs/authz`); `STAGE_ORDER.Idempotency` (500); `ackFaults`, `killConnection` (Task 2).
- Produces:
  - in `interfaces.ts`:
    - `type CommandOutcome = { readonly result: unknown } | { readonly error: unknown }`
    - `interface ISocketIdempotencyClaim { settle(outcome: CommandOutcome): Promise<IdempotentReply | null>; detach(running: Promise<unknown>): void }`
    - `ISocketCommandContext.idempotency?: ISocketIdempotencyClaim`
  - `@Injectable() class SocketIdempotency`:
    - `scope(connection: SocketConnection, key: string): string`: the store key for D1
    - `completed(scoped: string): Promise<boolean>`: whether the store holds `scoped` as done (a result or a final error)
    - `begin(scoped: string, name: string, signal: AbortSignal): Promise<{ reply: IdempotentReply } | { claim: ISocketIdempotencyClaim }>`
  - `@Injectable(SocketCommandStage) class IdempotencyStage` (Order 500)
  - `export const ELSEWHERE_RETRY_AFTER_MS = 1_000` (internal)
- Task 5 relies on `ctx.idempotency.settle()` being idempotent, with the first call winning, and on `detach()` leaving the key running until `running` settles.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket/test/idempotency.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { IdempotencyRecord, IdempotencyStore, MemoryIdempotencyStore } from '../src/idempotency.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer, waitFor } from './harness.js';

export const idemRuns = new Map<string, number>();
let idemGate: { promise: Promise<void>; open: () => void };

function newIdemGate(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  idemGate = { promise, open };
}

function run(tag: string): number {
  const n = (idemRuns.get(tag) ?? 0) + 1;
  idemRuns.set(tag, n);
  return n;
}

@SocketController('idem')
export class IdempotencySocket extends BaseSocketController {
  @Command('count', { idempotent: true })
  public async count(@Payload() p: { tag: string; ms?: number }) {
    const n = run(p.tag);
    if (p.ms) {
      await delay(p.ms);
    }
    return { tag: p.tag, run: n };
  }

  @Command('fail', { idempotent: true })
  public async fail(@Payload() p: { tag: string; code: 'conflict' | 'unavailable' | 'boom' }) {
    run(p.tag);
    if (p.code === 'boom') {
      throw new Error('handler exploded');
    }
    throw new SocketException(p.code, `failed with ${p.code}`);
  }

  @Command('hold', { idempotent: true })
  public async hold(@Payload() p: { tag: string }) {
    const n = run(p.tag);
    await idemGate.promise;
    return { tag: p.tag, run: n };
  }

  @Command('plain')
  public async plain() {
    return 'plain';
  }
}

/** Counts claims, so a test can see that the configured store class is the one in use. */
@Injectable(IdempotencyStore)
export class IdemCountingStore extends MemoryIdempotencyStore {
  public static claims = 0;

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    IdemCountingStore.claims++;
    return super.claim(key);
  }
}

describe('socket idempotent commands', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connect = async (clientId: string, token?: string) => {
    const socket = await open(t, { auth: { clientId, ...(token ? { token } : {}) } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    idemRuns.clear();
    newIdemGate();
    t = await startServer();
  });

  afterEach(async () => {
    idemGate.open();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('replays the stored reply of a finished key without running the handler again', async () => {
    const s = await connect('idem-replay');
    const first = resultOf(await command(s, 'idem.count', { tag: 'r' }, { idempotencyKey: 'k1' }));
    const second = resultOf(await command(s, 'idem.count', { tag: 'r' }, { idempotencyKey: 'k1' }));

    expect(first).to.deep.equal({ tag: 'r', run: 1 });
    expect(second).to.deep.equal(first);
    expect(idemRuns.get('r')).to.equal(1);
  });

  it('runs the handler once for concurrent requests with one key', async () => {
    const s = await connect('idem-concurrent');
    const replies = await Promise.all([1, 2, 3].map(() => command(s, 'idem.count', { tag: 'c', ms: 100 }, { idempotencyKey: 'k1' })));

    expect(replies.map((r) => resultOf(r))).to.deep.equal([1, 2, 3].map(() => ({ tag: 'c', run: 1 })));
    expect(idemRuns.get('c')).to.equal(1);
  });

  it('runs commands without a key every time', async () => {
    const s = await connect('idem-keyless');
    await command(s, 'idem.count', { tag: 'n' });
    await command(s, 'idem.count', { tag: 'n' });

    expect(idemRuns.get('n')).to.equal(2);
  });

  it('keeps keys apart by principal and by clientId', async () => {
    const alice = await connect('idem-scope', 'good');
    const anonymous = await connect('idem-scope');
    const aliceElsewhere = await connect('idem-scope-2', 'good');

    for (const s of [alice, anonymous, aliceElsewhere]) {
      await command(s, 'idem.count', { tag: 's' }, { idempotencyKey: 'same' });
    }

    expect(idemRuns.get('s')).to.equal(3);
  });

  it('stores a final error and replays it with the same errorId', async () => {
    const s = await connect('idem-final');
    const first = errorOf(await command(s, 'idem.fail', { tag: 'f', code: 'boom' }, { idempotencyKey: 'k1' }));
    const second = errorOf(await command(s, 'idem.fail', { tag: 'f', code: 'boom' }, { idempotencyKey: 'k1' }));
    const conflict = errorOf(await command(s, 'idem.fail', { tag: 'g', code: 'conflict' }, { idempotencyKey: 'k2' }));
    const conflictAgain = errorOf(await command(s, 'idem.fail', { tag: 'g', code: 'conflict' }, { idempotencyKey: 'k2' }));

    expect(first.code).to.equal('internal');
    expect(first.errorId).to.be.a('string');
    expect(second).to.deep.equal(first);
    expect(conflictAgain).to.deep.equal(conflict);
    expect(idemRuns.get('f')).to.equal(1);
    expect(idemRuns.get('g')).to.equal(1);
  });

  it('releases the key after a retryable failure, so a resend runs again', async () => {
    const s = await connect('idem-retry');
    const first = errorOf(await command(s, 'idem.fail', { tag: 'u', code: 'unavailable' }, { idempotencyKey: 'k1' }));
    await command(s, 'idem.fail', { tag: 'u', code: 'unavailable' }, { idempotencyKey: 'k1' });

    expect(first.retryable).to.be.true;
    expect(idemRuns.get('u')).to.equal(2);
  });

  it('refuses a key on a command that is not idempotent', async () => {
    const s = await connect('idem-plain');
    const error = errorOf(await command(s, 'idem.plain', undefined, { idempotencyKey: 'k1' }));

    expect(error.code).to.equal('failed_precondition');
    expect(error.retryable).to.be.false;
  });

  it('refuses after without an idempotencyKey', async () => {
    const s = await connect('idem-after');
    expect(errorOf(await command(s, 'idem.count', { tag: 'a' }, { after: 'k0' })).code).to.equal('invalid_argument');
    expect(idemRuns.has('a')).to.be.false;
  });

  it('keeps a key running after its connection dropped; the resend joins it and gets its result', async () => {
    const first = await connect('idem-drop');
    void command(first, 'idem.hold', { tag: 'h' }, { idempotencyKey: 'k1' }).catch(() => undefined);
    await waitFor(() => idemRuns.get('h') === 1);
    first.close();
    await delay(100);

    const second = await connect('idem-drop');
    const resent = command(second, 'idem.hold', { tag: 'h' }, { idempotencyKey: 'k1' });
    await delay(100);
    idemGate.open();

    expect(resultOf(await resent)).to.deep.equal({ tag: 'h', run: 1 });
    expect(idemRuns.get('h')).to.equal(1);
  });

  it('uses the store class named in http.socket.idempotency.service', async () => {
    await t.close();
    t = await startServer({ http: { socket: { idempotency: { service: 'IdemCountingStore' } } } });
    IdemCountingStore.claims = 0;
    const s = await connect('idem-store');

    await command(s, 'idem.count', { tag: 'st' }, { idempotencyKey: 'k1' });

    expect(IdemCountingStore.claims).to.equal(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/idempotency.test.ts`
Expected: 7 failing, 3 passing.
- Three tests pass trivially, because without the stage every request runs the handler: "runs commands without a key every time", "keeps keys apart by principal and by clientId" and "releases the key after a retryable failure".
- These fail:
  - "replays …", "runs the handler once …" and "keeps a key running …": the second run answers `run: 2`.
  - "stores a final error …": the second `internal` carries a new `errorId`.
  - "refuses a key …" and "refuses after …": `expected an error reply`.
  - "uses the store class …": `expected 0 to equal 1`.

- [ ] **Step 3: Add the claim types**

In `packages/http-socket/src/interfaces.ts`, append after `IdempotentReply`:

```ts
/** A command's outcome as the pipeline saw it. */
export type CommandOutcome = { readonly result: unknown } | { readonly error: unknown };

/** The idempotency stage's hold on one key while its command runs. */
export interface ISocketIdempotencyClaim {
  /**
   * Records the outcome once: a result or a final error is stored, a retryable error or the call's own
   * abort releases the key. Later calls get the first answer. Null: released, or detached.
   */
  settle(outcome: CommandOutcome): Promise<IdempotentReply | null>;
  /** The pipeline gave up on a handler that still runs: the key stays running until `running` settles, and `settle` answers null. */
  detach(running: Promise<unknown>): void;
}
```

In the same file, inside `ISocketCommandContext`, add after `rateRefusal?: unknown;`:

```ts
  /** set by the idempotency stage when it runs the command under a key; the ordering stage settles it inside the queue place */
  idempotency?: ISocketIdempotencyClaim;
```

In `ICommandOptions`, replace the doc comment of `idempotent` with `/** replay by principal, clientId and idempotencyKey; a durable command also needs ordered: 'client' */`.

In `packages/http-socket/src/context.ts`, import `ISocketIdempotencyClaim` together with the other names from `./interfaces.js`, and add the field after `public rateRefusal?: unknown;`:

```ts
  public idempotency?: ISocketIdempotencyClaim;
```

- [ ] **Step 4: Write `SocketIdempotency`**

In `packages/http-socket/src/idempotency.ts`:

1. Replace the import block with:

   ```ts
   import { Autoinject, Injectable } from '@spinajs/di';
   import { AutoinjectService, Config } from '@spinajs/configuration';
   import { Log, Logger } from '@spinajs/log';
   import { principalKey } from '@spinajs/authz';
   import { SocketException } from '@spinajs/http-socket-common';
   import type { CommandOutcome, IdempotentReply, ISocketIdempotencyClaim, ISocketIdempotencyConfig } from './interfaces.js';
   import type { SocketConnection } from './connection.js';
   import { SocketErrorMapper } from './errors.js';
   import { untilAborted } from './limits.js';
   ```

2. Append at the end of the file:

   ```ts
   /** Retry hint when another instance runs the key: this one cannot join it. */
   export const ELSEWHERE_RETRY_AFTER_MS = 1_000;

   function isAsyncIterable(value: unknown): boolean {
     return value !== null && typeof value === 'object' && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
   }

   /** The idempotency stage and the ordering stage's `after` fence share this: one store, one key scheme, one set of local runs. */
   @Injectable()
   export class SocketIdempotency {
     @Logger('http-socket')
     protected Log: Log;

     @AutoinjectService('http.socket.idempotency', IdempotencyStore)
     protected Store: IdempotencyStore;

     @Config('http.socket.idempotency')
     protected Options: ISocketIdempotencyConfig;

     @Autoinject()
     protected Errors: SocketErrorMapper;

     /** Keys this instance runs: resolves with the stored reply, or null once the key was released. */
     protected local = new Map<string, Promise<IdempotentReply | null>>();

     /** A clientId is not a secret, so a stored reply must never reach another principal. */
     public scope(connection: SocketConnection, key: string): string {
       return [principalKey(connection.principal), connection.clientId, key].map(encodeURIComponent).join(':');
     }

     public async completed(scoped: string): Promise<boolean> {
       return (await this.Store.get(scoped))?.state === 'done';
     }

     public async begin(scoped: string, name: string, signal: AbortSignal): Promise<{ reply: IdempotentReply } | { claim: ISocketIdempotencyClaim }> {
       for (;;) {
         const held = await this.Store.claim(scoped);

         if (held === null) {
           return { claim: this.claim(scoped, name, signal) };
         }

         if (held.state === 'done') {
           return { reply: held.reply };
         }

         const running = this.local.get(scoped);
         if (!running) {
           throw new SocketException('unavailable', `command ${name} with this idempotency key is running on another server instance`, { retryAfterMs: ELSEWHERE_RETRY_AFTER_MS });
         }

         const reply = await untilAborted(running, signal);
         if (reply) {
           return { reply };
         }
         // released by a run that produced no outcome: claim it again
       }
     }

     protected claim(scoped: string, name: string, signal: AbortSignal): ISocketIdempotencyClaim {
       let publish!: (reply: IdempotentReply | null) => void;
       this.local.set(scoped, new Promise((resolve) => (publish = resolve)));

       let answer: Promise<IdempotentReply | null> | null = null;
       let detached = false;

       const finish = (outcome: CommandOutcome): Promise<IdempotentReply | null> =>
         (answer ??= this.record(scoped, name, signal, outcome).then(
           (reply) => {
             this.local.delete(scoped);
             publish(reply);
             return reply;
           },
           (err: unknown) => {
             this.local.delete(scoped);
             publish(null);
             throw err;
           },
         ));

       return {
         settle: (outcome) => (detached ? Promise.resolve(null) : finish(outcome)),
         detach: (running) => {
           if (answer || detached) {
             return;
           }

           detached = true;
           running
             .then(
               (result) => finish({ result }),
               (error: unknown) => finish({ error }),
             )
             .catch((err: Error) => this.Log.error(err, `Socket command ${name}: recording the outcome of its detached handler failed`));
         },
       };
     }

     protected async record(scoped: string, name: string, signal: AbortSignal, outcome: CommandOutcome): Promise<IdempotentReply | null> {
       if ('result' in outcome) {
         // a stream reply cannot be replayed
         if (isAsyncIterable(outcome.result)) {
           await this.Store.release(scoped);
           return null;
         }

         const reply: IdempotentReply = { ok: true, result: outcome.result === undefined ? null : outcome.result };
         await this.Store.complete(scoped, reply, this.Options.ttlMs);
         return reply;
       }

       // the call's own deadline, cancel, disconnect or shutdown: the command produced no outcome
       if (signal.aborted && outcome.error === signal.reason) {
         await this.Store.release(scoped);
         return null;
       }

       const error = this.Errors.toWire(outcome.error, `command ${name}`);
       if (error.retryable) {
         await this.Store.release(scoped);
         return null;
       }

       const reply: IdempotentReply = { ok: false, error };
       await this.Store.complete(scoped, reply, this.Options.ttlMs);
       return reply;
     }
   }
   ```

- [ ] **Step 5: Write the stage**

Create `packages/http-socket/src/stages/idempotency.ts`:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketIdempotency } from '../idempotency.js';

/**
 * Spec §5.2 step 5. A completed key replays its stored reply, and a running one is joined, so the
 * handler never runs twice for one principal, clientId and key. It comes after the authentication
 * stage, so an expired principal gets no replay.
 */
@Injectable(SocketCommandStage)
export class IdempotencyStage extends SocketCommandStage {
  @Autoinject()
  protected Idempotency: SocketIdempotency;

  public get Order(): number {
    return STAGE_ORDER.Idempotency;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const { idempotencyKey: key, after, name } = ctx.request;

    if (key === undefined) {
      if (after !== undefined) {
        throw new SocketException('invalid_argument', 'a command with after needs an idempotencyKey');
      }
      return next();
    }

    // the client would believe it is deduplicated
    if (!ctx.handler?.descriptor.Options.idempotent) {
      throw new SocketException('failed_precondition', `command ${name} is not idempotent, so it cannot take an idempotencyKey`);
    }

    const begun = await this.Idempotency.begin(this.Idempotency.scope(ctx.connection, key), name, ctx.signal);

    if ('reply' in begun) {
      if (begun.reply.ok) {
        return begun.reply.result;
      }
      throw SocketException.fromWire(begun.reply.error);
    }

    const claim = begun.claim;
    ctx.idempotency = claim;

    let result: unknown;
    try {
      result = await next();
    } catch (err) {
      const reply = await claim.settle({ error: err });
      // the stored error, so this reply and every replay carry the same errorId
      if (reply && !reply.ok) {
        throw SocketException.fromWire(reply.error);
      }
      throw err;
    }

    await claim.settle({ result });
    return result;
  }
}
```

In `packages/http-socket/src/stages/index.ts`, add `export * from './idempotency.js';` after the `lookup.js` line.

In `packages/http-socket/src/index.ts`, replace the idempotency export line from Task 3 with:

```ts
export { IdempotencyStore, MemoryIdempotencyStore, SocketIdempotency } from './idempotency.js';
```

The new types `CommandOutcome`, `IdempotentReply` and `ISocketIdempotencyClaim` need no extra line: `export * from './interfaces.js'` already exports them.

In `packages/http-socket/test/exports.test.ts`:
- insert `'IdempotencyStage',` between `'IN_FLIGHT_RETRY_AFTER_MS',` and `'IdempotencyStore',`
- insert `'SocketIdempotency',` between `'SocketHub',` and `'SocketParameter',`

- [ ] **Step 6: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/idempotency.test.ts test/exports.test.ts test/pipeline.test.ts test/ordering.test.ts test/signals.test.ts`
Expected: `0 failing`. `idempotency.test.ts` reports `10 passing`.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/idempotency.ts packages/http-socket/src/stages/idempotency.ts packages/http-socket/src/stages/index.ts packages/http-socket/src/interfaces.ts packages/http-socket/src/context.ts packages/http-socket/src/index.ts packages/http-socket/test/idempotency.test.ts packages/http-socket/test/exports.test.ts && \
git commit -m "feat(http-socket): idempotency stage replays and joins by principal, clientId and key"
```

---

### Task 5: The `after` fence and outcomes recorded inside the queue place

**Files:**
- Modify: `packages/http-socket/src/stages/ordering.ts` (whole file, below)
- Test: `packages/http-socket/test/durable-order.test.ts`

**Interfaces:**
- Consumes: `SocketIdempotency.scope()` and `.completed()`, and `ISocketCommandContext.idempotency` with `settle()` and `detach()` (Task 4); `SerialQueue`; `ordering.abortGraceMs`.
- Produces: the behaviour the durable client (Task 9) relies on.
  - A request with `after` runs only when the store holds `after` (scoped like its own key) as completed. Otherwise it gets a retryable `unavailable`, and its own key is released.
  - The outcome of an ordered idempotent command is stored before its queue place is released.
  - A handler cut loose after `abortGraceMs` keeps its key running until it settles.
  - `after` on a command that is not `ordered: 'client'` gets `failed_precondition`.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket/test/durable-order.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { ErrorCode, SocketException } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer, waitFor } from './harness.js';

export const fenceLog: string[] = [];
let fenceGate: { promise: Promise<void>; open: () => void };

function newFenceGate(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  fenceGate = { promise, open };
}

@SocketController('fence')
export class FenceSocket extends BaseSocketController {
  @Command('step', { idempotent: true, ordered: 'client' })
  public async step(@Payload() p: { tag: string; ms?: number; fail?: ErrorCode }) {
    fenceLog.push(p.tag);
    if (p.ms) {
      await delay(p.ms);
    }
    if (p.fail) {
      throw new SocketException(p.fail, `${p.tag} failed`);
    }
    return p.tag;
  }

  @Command('hang', { idempotent: true, ordered: 'client', timeoutMs: 50 })
  public async hang(@Payload() p: { tag: string }) {
    fenceLog.push(p.tag);
    await fenceGate.promise;
    fenceLog.push(`${p.tag}:end`);
    return p.tag;
  }

  @Command('loose', { idempotent: true })
  public async loose() {
    fenceLog.push('loose');
    return 'loose';
  }
}

describe('durable command order: the after fence', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connect = async (clientId: string, cfg?: Record<string, unknown>) => {
    if (cfg) {
      await t.close();
      t = await startServer(cfg);
    }
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    fenceLog.length = 0;
    newFenceGate();
    t = await startServer();
  });

  afterEach(async () => {
    fenceGate.open();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('runs a command whose predecessor completed', async () => {
    const s = await connect('fence-done');
    expect(resultOf(await command(s, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(resultOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
  });

  it('accepts a predecessor that completed on an earlier connection of the client', async () => {
    const first = await connect('fence-reconnect');
    await command(first, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' });
    first.close();

    const second = await connect('fence-reconnect');
    expect(resultOf(await command(second, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
  });

  it('refuses a command whose predecessor never arrived, with a retryable unavailable', async () => {
    const s = await connect('fence-missing');
    const error = errorOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'zzz' }));

    expect(error).to.include({ code: 'unavailable', retryable: true });
    expect(fenceLog).to.deep.equal([]);
  });

  it('lets a command sent right behind its predecessor wait for it', async () => {
    const s = await connect('fence-pipelined');
    const [a, b] = await Promise.all([command(s, 'fence.step', { tag: 'a', ms: 100 }, { idempotencyKey: 'a' }), command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' })]);

    expect([resultOf(a), resultOf(b)]).to.deep.equal(['a', 'b']);
    expect(fenceLog).to.deep.equal(['a', 'b']);
  });

  it('does not block behind a predecessor that failed for good', async () => {
    const s = await connect('fence-final');
    const [a, b] = await Promise.all([command(s, 'fence.step', { tag: 'a', fail: 'conflict' }, { idempotencyKey: 'a' }), command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' })]);

    expect(errorOf(a).code).to.equal('conflict');
    expect(resultOf(b)).to.equal('b');
  });

  it('blocks behind a predecessor that failed retryably, and releases the blocked key', async () => {
    const s = await connect('fence-retryable');
    const [a, b] = await Promise.all([command(s, 'fence.step', { tag: 'a', fail: 'unavailable' }, { idempotencyKey: 'a' }), command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' })]);

    expect(errorOf(a).code).to.equal('unavailable');
    expect(errorOf(b)).to.include({ code: 'unavailable', retryable: true });
    expect(fenceLog).to.deep.equal(['a']);

    // both keys were released: the resend in order runs them
    expect(resultOf(await command(s, 'fence.step', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(resultOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
  });

  it('records a predecessor that finished after its deadline, so its successor runs and a resend replays it', async () => {
    const s = await connect('fence-late');
    const a = command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' });
    const b = command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' });

    expect(errorOf(await a).code).to.equal('deadline_exceeded');
    await delay(50);
    fenceGate.open();

    expect(resultOf(await b)).to.equal('b');
    expect(resultOf(await command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(fenceLog).to.deep.equal(['a', 'a:end', 'b']);
  });

  it('keeps the key of a handler cut loose after the abort grace running, so its successor waits for it', async () => {
    const s = await connect('fence-loose', { http: { socket: { ordering: { abortGraceMs: 200 } } } });
    const a = command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' });
    const b = command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' });

    expect(errorOf(await a).code).to.equal('deadline_exceeded');
    expect(errorOf(await b)).to.include({ code: 'unavailable', retryable: true });

    fenceGate.open();
    await waitFor(() => fenceLog.includes('a:end'));
    await delay(20);

    expect(resultOf(await command(s, 'fence.step', { tag: 'b' }, { idempotencyKey: 'b', after: 'a' }))).to.equal('b');
    expect(resultOf(await command(s, 'fence.hang', { tag: 'a' }, { idempotencyKey: 'a' }))).to.equal('a');
    expect(fenceLog).to.deep.equal(['a', 'a:end', 'b']);
  });

  it("refuses after on a command that is not ordered: 'client'", async () => {
    const s = await connect('fence-unordered');
    const error = errorOf(await command(s, 'fence.loose', undefined, { idempotencyKey: 'k', after: 'a' }));

    expect(error.code).to.equal('failed_precondition');
    expect(fenceLog).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/durable-order.test.ts`
Expected: 4 failing, 5 passing.
- These fail, because nothing reads `after` yet:
  - "refuses a command whose predecessor never arrived …" (`expected an error reply`)
  - "blocks behind a predecessor that failed retryably …" (`expected an error reply`)
  - "keeps the key of a handler cut loose …" (`expected an error reply`)
  - "refuses after on a command that is not ordered …" (`expected an error reply`)
- The cut-loose test also fails for a deeper reason. Today the abort reason releases `a`, so the resent `a` would run a second time.

- [ ] **Step 3: Implement**

Replace `packages/http-socket/src/stages/ordering.ts` with:

```ts
import { Autoinject, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { ISocketCommandContext, ISocketServerConfig, STAGE_ORDER, SocketCommandStage } from '../interfaces.js';
import { SocketIdempotency } from '../idempotency.js';
import { SerialQueue } from '../queue.js';

/**
 * `ordered: 'connection'` serialises a connection's commands; `ordered: 'client'` serialises the
 * commands of one principal and clientId across reconnects. In memory, per server instance.
 *
 * A durable command names its predecessor's idempotency key in `after` and runs only once that one
 * has completed. Pipelining, resends and refusals before this stage ( rate, in flight, a drop ) could
 * otherwise let it overtake.
 */
@Injectable(SocketCommandStage)
export class OrderingStage extends SocketCommandStage {
  @Logger('http-socket')
  protected Log: Log;

  @Config('http.socket')
  protected Options: ISocketServerConfig;

  @Autoinject()
  protected Idempotency: SocketIdempotency;

  protected Queue = new SerialQueue();

  public get Order(): number {
    return STAGE_ORDER.Ordering;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    const mode = ctx.handler?.descriptor.Options.ordered;

    if (ctx.request.after !== undefined && mode !== 'client') {
      throw new SocketException('failed_precondition', `command ${ctx.request.name} is not ordered: 'client', so it cannot take after`);
    }

    if (!mode) {
      return next();
    }

    // clientId is chosen by the client, so another principal sending the same one must not stall this queue;
    // the encoded principal key holds no ':', which keeps the key unambiguous
    const key = mode === 'client' ? `client:${encodeURIComponent(principalKey(ctx.connection.principal))}:${ctx.connection.clientId}` : `connection:${ctx.connection.id}`;

    return this.Queue.run(key, async () => {
      // already answered ( deadline, cancel, disconnect ) while it waited: never start the handler
      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }

      await this.assertAfter(ctx);

      // The place is held until the handler settles: releasing on abort would let a resent command
      // run while the aborted one still applies. A handler that never settles is cut loose after the grace.
      const running = next();
      const settled = new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          timer = setTimeout(() => {
            this.Log.error(`Ordered command ${ctx.request.name} on ${key} still running ${this.Options.ordering.abortGraceMs} ms after abort, releasing its queue place`);
            resolve(false);
          }, this.Options.ordering.abortGraceMs);
          timer.unref();
        };
        const done = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolve(true);
        };

        ctx.signal.addEventListener('abort', onAbort, { once: true });
        running.then(done, done);
      });

      // cut loose: the dispatcher has answered the abort already, a late handler result is dropped there
      if (!(await settled)) {
        // the key stays running until the handler settles, so a resend joins it instead of running it twice
        ctx.idempotency?.detach(running);
        throw ctx.signal.reason;
      }

      // recorded before this place is released: the next command's after check must see it
      await running.then(
        (result) => ctx.idempotency?.settle({ result }),
        (error: unknown) => ctx.idempotency?.settle({ error }),
      );

      return running;
    });
  }

  protected async assertAfter(ctx: ISocketCommandContext): Promise<void> {
    const after = ctx.request.after;

    if (after !== undefined && !(await this.Idempotency.completed(this.Idempotency.scope(ctx.connection, after)))) {
      throw new SocketException('unavailable', `command ${ctx.request.name} must follow ${after}, which has not completed`);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/durable-order.test.ts test/ordering.test.ts test/idempotency.test.ts`
Expected: `0 failing`. `durable-order.test.ts` reports `9 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/stages/ordering.ts packages/http-socket/test/durable-order.test.ts && \
git commit -m "feat(http-socket): durable commands run only after their predecessor completed"
```

---

### Task 6: Graceful shutdown

**Files:**
- Modify: `packages/http-socket/src/server.ts` (`resolve`, `dispose` → `shutdown`, `authenticate`, `onConnection`)
- Modify: `packages/http-socket/src/dispatcher.ts` (`onCommand`, `detach`, new `refuseNew` / `drained` / `hooksDone` / `track`)
- Modify: `packages/http-socket/src/limits.ts` (`assertShutdownConfig`)
- Modify: `packages/http-socket/src/interfaces.ts` (`drainMs` doc, `shutdownRetryAfterMs`)
- Modify: `packages/http-socket/src/config/http-socket.ts`, `packages/http-socket/test/config.test.ts`
- Modify: `packages/http-socket/test/harness.ts` (test config `drainMs: 0`)
- Test: `packages/http-socket/test/shutdown.test.ts`

**Interfaces:**
- Consumes: `SocketConnection.notify(SYSTEM_EVENTS.shutdown, ShutdownNotice)`, `SocketHub.Connections`, `SocketDispatcher.abortAll`, `SocketPrincipalGuard.stop`, `DI.on/off/emit`.
- Produces:
  - `SocketServer.shutdown(): Promise<void>`: idempotent; `dispose()` awaits it; it also starts on the DI event `http.server.closing`
  - `SocketDispatcher.refuseNew(refusal: SocketException): void` (`@internal`)
  - `SocketDispatcher.drained(ms: number): Promise<boolean>` (`@internal`): true once every command received so far has been answered
  - `SocketDispatcher.hooksDone(ms: number): Promise<boolean>` (`@internal`)
  - `assertShutdownConfig(options: Pick<ISocketServerConfig, 'drainMs' | 'shutdownRetryAfterMs'>): void` (internal)
  - config `http.socket.shutdownRetryAfterMs` (default `5_000`)
- The client side needs nothing new. W2 already waits `retryAfterMs` after `sys.shutdown`, and a refused handshake carries the same hint.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket/test/shutdown.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { SYSTEM_EVENTS, ShutdownNotice } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnDisconnect, Payload, Signal, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { assertShutdownConfig } from '../src/limits.js';
import { ITestServer, command, connect, delay, errorOf, nextEvent, open, refusalOf, resultOf, startServer } from './harness.js';

export const shutAborts: string[] = [];
export const shutHooks: boolean[] = [];

@SocketController('shut')
export class ShutdownSocket extends BaseSocketController {
  @Command('work')
  public async work(@Payload() p: { ms: number }) {
    await delay(p.ms);
    return 'done';
  }

  @Command('hang')
  public async hang(@Signal() signal: AbortSignal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    shutAborts.push((signal.reason as { code: string }).code);
    return 'late';
  }

  @Command('join')
  public async join(@Connection() conn: SocketConnection) {
    conn.join('shut-room');
    return true;
  }

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection) {
    if (conn.clientId !== 'shut-hooks') {
      return;
    }

    await delay(100);
    try {
      DI.resolve(SocketHub).to('shut-room').emit('shut.bye', {});
      shutHooks.push(true);
    } catch {
      shutHooks.push(false);
    }
  }
}

const CFG = { http: { socket: { drainMs: 2_000, shutdownRetryAfterMs: 700 } } };

describe('socket graceful shutdown', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connectAs = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    shutAborts.length = 0;
    shutHooks.length = 0;
    t = await startServer(CFG);
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('tells every connection when to come back, then lets a running command finish', async () => {
    const s = await connectAs('shut-finish');
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.work', { ms: 300 });
    await delay(50);

    const stopped = t.server.shutdown();

    expect(await notice).to.deep.equal({ retryAfterMs: 700 });
    expect(resultOf(await running)).to.equal('done');
    await stopped;
  });

  it('answers commands sent during the drain with unavailable and retryAfterMs', async () => {
    const s = await connectAs('shut-new');
    const notice = nextEvent(s, SYSTEM_EVENTS.shutdown);
    const running = command(s, 'shut.work', { ms: 300 });
    await delay(50);
    const stopped = t.server.shutdown();
    await notice;

    const error = errorOf(await command(s, 'shut.work', { ms: 0 }));

    expect(error).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
    await running;
    await stopped;
  });

  it('refuses new handshakes during the drain with unavailable and retryAfterMs', async () => {
    const s = await connectAs('shut-handshake');
    const running = command(s, 'shut.work', { ms: 300 });
    await delay(50);
    const stopped = t.server.shutdown();

    const late = connect(t, { auth: { clientId: 'shut-late' } });
    const refusal = await refusalOf(late);
    late.close();

    expect(refusal).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 700 });
    await running;
    await stopped;
  });

  it('answers a command still running after drainMs with unavailable instead of dropping the reply', async () => {
    await t.close();
    t = await startServer({ http: { socket: { drainMs: 200, shutdownRetryAfterMs: 700 } } });
    const s = await connectAs('shut-abort');
    const hanging = command(s, 'shut.hang');
    await delay(50);

    await t.server.shutdown();

    expect(errorOf(await hanging)).to.include({ code: 'unavailable', retryAfterMs: 700 });
    expect(shutAborts).to.deep.equal(['unavailable']);
  });

  it('waits for the disconnect hooks, which can still push, before it closes', async () => {
    const s = await connectAs('shut-hooks');
    await command(s, 'shut.join');

    await t.server.shutdown();

    expect(shutHooks).to.deep.equal([true]);
  });

  it('starts when the http server announces that it is closing', async () => {
    const s = await connectAs('shut-http');
    const notice = nextEvent<ShutdownNotice>(s, SYSTEM_EVENTS.shutdown);

    DI.emit('http.server.closing');

    expect(await notice).to.deep.equal({ retryAfterMs: 700 });
  });

  it('is idempotent, and dispose waits for it', async () => {
    const first = t.server.shutdown();

    expect(t.server.shutdown()).to.equal(first);
    await Promise.all([first, t.server.dispose()]);
    expect(t.server.Io).to.be.null;
  });

  it('refuses a drainMs or shutdownRetryAfterMs it cannot use', () => {
    expect(() => assertShutdownConfig({ drainMs: 0, shutdownRetryAfterMs: 1 })).not.to.throw();

    for (const bad of [
      { drainMs: -1, shutdownRetryAfterMs: 1 },
      { drainMs: Number.NaN, shutdownRetryAfterMs: 1 },
      { drainMs: 2 ** 31, shutdownRetryAfterMs: 1 },
      { drainMs: 0, shutdownRetryAfterMs: 0 },
      { drainMs: 0, shutdownRetryAfterMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => assertShutdownConfig(bad), JSON.stringify(bad)).to.throw(RangeError);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/shutdown.test.ts`
Expected: FAIL to compile, with `Property 'shutdown' does not exist on type 'SocketServer'` and `Module '"../src/limits.js"' has no exported member 'assertShutdownConfig'`.

- [ ] **Step 3: Configuration and its check**

In `packages/http-socket/src/interfaces.ts`, replace the line `  drainMs: number;` of `ISocketServerConfig` with:

```ts
  /** shutdown: how long running commands may finish before they are answered `unavailable` */
  drainMs: number;
  /** shutdown: the `retryAfterMs` of `sys.shutdown` and of every refusal during the drain */
  shutdownRetryAfterMs: number;
```

In `packages/http-socket/src/config/http-socket.ts`, replace `      drainMs: 5_000,` with:

```ts
      drainMs: 5_000,
      shutdownRetryAfterMs: 5_000,
```

In `packages/http-socket/test/config.test.ts`, add after `expect(socket.drainMs).to.equal(5_000);`:

```ts
    expect(socket.shutdownRetryAfterMs).to.equal(5_000);
```

Append to `packages/http-socket/src/limits.ts`:

```ts
const MAX_TIMER_MS = 2 ** 31 - 1;

export function assertShutdownConfig(options: Pick<ISocketServerConfig, 'drainMs' | 'shutdownRetryAfterMs'>): void {
  const { drainMs, shutdownRetryAfterMs } = options;

  if (!(typeof drainMs === 'number' && drainMs >= 0 && drainMs <= MAX_TIMER_MS)) {
    throw new RangeError(`http.socket.drainMs must be within [0, ${MAX_TIMER_MS}], got ${String(drainMs)}`);
  }

  if (!(typeof shutdownRetryAfterMs === 'number' && shutdownRetryAfterMs > 0 && Number.isFinite(shutdownRetryAfterMs))) {
    throw new RangeError(`http.socket.shutdownRetryAfterMs must be a finite number above 0, got ${String(shutdownRetryAfterMs)}`);
  }
}
```

In `packages/http-socket/test/harness.ts`, in `TestConfiguration.onLoad`, replace `http: { socket: _.cloneDeep(socketConfig.http.socket) },` with:

```ts
        // W1's tests close servers with handlers still running; without a drain they close as fast as before
        http: { socket: { ..._.cloneDeep(socketConfig.http.socket), drainMs: 0 } },
```

- [ ] **Step 4: The dispatcher drains**

In `packages/http-socket/src/dispatcher.ts`:

1. Add after `function isAsyncIterable(…) {…}`:

   ```ts
   /** True once every promise settled; false when `ms` passes first. */
   function within(work: Array<Promise<unknown>>, ms: number): Promise<boolean> {
     if (work.length === 0) {
       return Promise.resolve(true);
     }

     let timer: ReturnType<typeof setTimeout> | undefined;
     const timeout = new Promise<boolean>((resolve) => {
       timer = setTimeout(() => resolve(false), ms);
     });

     return Promise.race([Promise.all(work).then(() => true), timeout]).finally(() => clearTimeout(timer));
   }
   ```

2. Add these fields after `protected runtimes = new Map<string, IConnectionRuntime>();`:

   ```ts
   /** From arrival to written reply; the shutdown drain waits for them. */
   protected replies = new Set<Promise<void>>();

   protected hookRuns = new Set<Promise<void>>();

   /** Set by shutdown: every new command is answered with it. */
   protected refusal: SocketException | null = null;
   ```

3. In `onCommand`, insert right after the `if (!isCommandRequest(raw)) { … }` block:

   ```ts
       if (this.refusal) {
         this.refuse(reply, raw.id, raw.name, this.refusal);
         return;
       }
   ```

   and replace its last line, `void this.execute(ctx).then((answer) => this.send(reply, answer, raw.name));`, with:

   ```ts
       this.track(this.replies, this.execute(ctx).then((answer) => this.send(reply, answer, raw.name)));
   ```

4. In `detach`, replace the `void runtime.ready.then(…)` line with:

   ```ts
       this.track(
         this.hookRuns,
         runtime.ready.then(() => this.runHooks(runtime, 'disconnect', reason)).catch((err: Error) => this.Log.error(err, `Socket disconnect hooks of connection ${connection.id} failed`)),
       );
   ```

5. Add after `abortAll`:

   ```ts
   /** @internal From now on every new command is answered with `refusal` ( shutdown ). */
   public refuseNew(refusal: SocketException): void {
     this.refusal = refusal;
   }

   /** @internal True once every command received so far has been answered; false when `ms` passes first. */
   public drained(ms: number): Promise<boolean> {
     return within([...this.replies], ms);
   }

   /** @internal True once every disconnect hook started so far is done; false when `ms` passes first. */
   public hooksDone(ms: number): Promise<boolean> {
     return within([...this.hookRuns], ms);
   }

   protected track(set: Set<Promise<void>>, work: Promise<void>): void {
     set.add(work);
     const forget = () => set.delete(work);
     work.then(forget, forget);
   }
   ```

- [ ] **Step 5: The server shuts down in order**

In `packages/http-socket/src/server.ts`:

1. Change the imports:
   - `import { AsyncService, Autoinject, ClassInfo, DI, Injectable } from '@spinajs/di';`
   - add `ShutdownNotice` to the `@spinajs/http-socket-common` import list
   - add `import { assertShutdownConfig } from './limits.js';`

2. Add after `type Listener = …;`:

   ```ts
   /** How long the replies of commands aborted at the end of a drain get to reach their transport. */
   const REPLY_FLUSH_MS = 1_000;
   ```

3. Add these fields after `protected handshakes = new WeakMap<Socket, ISocketHandshake>();`:

   ```ts
   /** Set when shutdown starts; handshakes and recovered sockets are refused with it. */
   protected closing: SocketException | null = null;

   protected stopping: Promise<void> | null = null;

   protected onHttpClosing = (): void => {
     this.shutdown().catch((err: Error) => this.Log.error(err, 'Socket server shutdown failed'));
   };
   ```

4. In `resolve()`, add `assertShutdownConfig(this.Options);` right after the `assertIdempotencyConfig(…)` line from Task 3. Add `DI.on('http.server.closing', this.onHttpClosing);` as its last line, after `this.Guard.start(…)`.

5. Replace the whole `dispose()` method with:

   ```ts
   /**
    * Graceful shutdown ( spec §5.5 ): refuse new connections and commands, tell the clients when to come
    * back, let running commands finish for up to `drainMs`, answer the rest `unavailable`, then close.
    * Also started by the http server's `http.server.closing`; idempotent.
    */
   public shutdown(): Promise<void> {
     return (this.stopping ??= this.drainAndClose());
   }

   public async dispose(): Promise<void> {
     await this.shutdown();
   }

   protected async drainAndClose(): Promise<void> {
     const io = this._io;
     if (!io) {
       return;
     }

     DI.off('http.server.closing', this.onHttpClosing);

     const retryAfterMs = this.Options.shutdownRetryAfterMs;
     const unavailable = new SocketException('unavailable', 'server is shutting down', { retryAfterMs });
     this.closing = unavailable;
     this.Dispatcher.refuseNew(unavailable);
     this.Guard.stop();

     const notice: ShutdownNotice = { retryAfterMs };
     // per connection, not io.emit: with an adapter that would reach the clients of the other instances
     for (const connection of this.Hub.Connections.values()) {
       connection.notify(SYSTEM_EVENTS.shutdown, notice);
     }

     if (!(await this.Dispatcher.drained(this.Options.drainMs))) {
       this.Log.warn(`Socket commands still running after a ${this.Options.drainMs} ms drain are answered unavailable`);
       this.Dispatcher.abortAll(unavailable);
       // the abort answers at once, but the replies are written in later microtasks; closing first would drop them
       await this.Dispatcher.drained(REPLY_FLUSH_MS);
     }

     io.disconnectSockets(true);

     // disconnect hooks may still push to rooms, so the hub stays attached until they are done
     if (!(await this.Dispatcher.hooksDone(this.Options.drainMs))) {
       this.Log.warn(`Socket disconnect hooks still running after ${this.Options.drainMs} ms, closing anyway`);
     }

     // not io.close(): that also closes the http server, which the host owns
     await Promise.allSettled([...io._nsps.values()].map((nsp) => nsp.adapter.close()));
     io.engine.close();
     this.releaseHost?.();
     this.releaseHost = null;
     this._io = null;
     this.Hub.detach();
   }
   ```

6. In `authenticate()`, insert as the first statement inside `try {`:

   ```ts
         if (this.closing) {
           throw this.closing;
         }
   ```

7. In `onConnection()`, insert right after `this.handshakes.delete(socket);`:

   ```ts
       // a recovered socket skipped the handshake middleware, where the closing refusal sits
       if (this.closing) {
         this.refuseConnected(socket, this.closing.toWire());
         return;
       }
   ```

- [ ] **Step 6: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/shutdown.test.ts test/signals.test.ts test/handshake-security.test.ts test/revalidation.test.ts test/config.test.ts`
Expected: `0 failing`. `shutdown.test.ts` reports `8 passing`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npm test`
Expected: `0 failing`.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/server.ts packages/http-socket/src/dispatcher.ts packages/http-socket/src/limits.ts packages/http-socket/src/interfaces.ts packages/http-socket/src/config/http-socket.ts packages/http-socket/test/config.test.ts packages/http-socket/test/harness.ts packages/http-socket/test/shutdown.test.ts && \
git commit -m "feat(http-socket): graceful shutdown with sys.shutdown, a bounded drain and flushed unavailable replies"
```

---

### Task 7: Recovery: the `recovered` flag and a principal re-check

**Files:**
- Modify: `packages/http-socket/src/connection.ts` (`recovered`)
- Modify: `packages/http-socket/src/principal-guard.ts` (`recheck`)
- Modify: `packages/http-socket/src/dispatcher.ts` (`attach`, new `afterRecovery`)
- Test: `packages/http-socket/test/recovery.test.ts` (helper change and three new tests)

**Interfaces:**
- Consumes: `socket.recovered` (socket.io 4.8), `SocketPrincipalGuard.check()`, `.pending` and `.isClosing()`.
- Produces:
  - `SocketConnection.recovered: boolean`: the connect hooks run again after a recovery and can read it (`@Connection() conn` → `conn.recovered`)
  - `SocketPrincipalGuard.recheck(connection): Promise<void>` (`@internal`)
  - A recovered connection whose principal has a source is re-checked with that source before its connect hooks and commands run (Open question 4). An `'invalid'` answer closes it with `sys.disconnect { reason: 'unauthenticated' }`. A `'valid'` answer that carries a principal replaces the restored one, flattened identity included.

- [ ] **Step 1: Write the failing tests**

In `packages/http-socket/test/recovery.test.ts`:

1. Replace `import { WIRE_EVENTS } from '@spinajs/http-socket-common';` with these three lines:

   ```ts
   import { SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
   import { BaseSocketController } from '../src/controller.js';
   import { Connection, OnConnect, SocketController } from '../src/decorators.js';
   ```

2. Add above `RecoverySource`:

   ```ts
   export class RecoveredUser {
     constructor(public readonly name: string) {}

     public greet(): string {
       return `hi ${this.name}`;
     }
   }

   export const recoveryHooks: boolean[] = [];

   @SocketController('recovery')
   export class RecoveryHookSocket extends BaseSocketController {
     @OnConnect()
     public async seen(@Connection() conn: SocketConnection) {
       if (conn.clientId === 'recov-hooks') {
         recoveryHooks.push(conn.recovered);
       }
     }
   }
   ```

3. In `RecoverySource.authenticate`, replace the `return` statement with:

   ```ts
       return {
         type: 'user',
         id: token,
         authenticated: true,
         source: 'token',
         attributes: {},
         ...(token === 'recov-expiring' ? { ceiling: { expiresAt: new Date(Date.now() + 300) } } : {}),
         ...(token === 'recov-user' ? { identity: new RecoveredUser('ann') } : {}),
       };
   ```

4. Replace the `reconnect` helper with a version that resends the credentials, as the W2 client does on every attempt:

   ```ts
   /** Reconnects with the stored session; resolves whether the missed packet was replayed. */
   const reconnect = async (pid: string, offset: string, auth: Record<string, unknown> = {}) => {
     const second = track(connect(t, { auth: { pid, offset, ...auth } }));
     const missed = nextEvent(second, 'recovery.missed', 300).then(
       () => true,
       () => false,
     );
     await connected(second);
     return { second, replayed: await missed };
   };
   ```

5. In `it('recovers a connection whose principal is still valid, with its missed packets', …)`, change the reconnect line to `const { second, replayed } = await reconnect(pid, offset, { token: 'recov-ok' });`.

6. Add these tests at the end of the `describe` block:

   ```ts
   it('tells the connect hooks whether the connection was recovered', async () => {
     t = await startServer();
     recoveryHooks.length = 0;
     const { pid, offset } = await dropped({ auth: { clientId: 'recov-hooks', token: 'recov-ok' } });

     const { second } = await reconnect(pid, offset, { clientId: 'recov-hooks', token: 'recov-ok' });
     await waitFor(() => recoveryHooks.length === 2);

     expect(recovered(second)).to.be.true;
     expect(recoveryHooks).to.deep.equal([false, true]);
   });

   it('re-checks the principal of a recovered connection and closes it when the source refuses it', async () => {
     t = await startServer();
     const { pid, offset } = await dropped({ auth: { token: 'recov-ok' } });

     // no token this time: the source no longer authenticates the connection
     const second = track(connect(t, { auth: { pid, offset } }));
     const kicked = nextEvent<{ reason: string }>(second, SYSTEM_EVENTS.disconnect);
     await connected(second);

     expect(await kicked).to.deep.equal({ reason: 'unauthenticated' });
   });

   it('brings back the identity that a serializing adapter flattened', async () => {
     t = await startServer();
     const adapter = t.server.Io!.of('/').adapter as unknown as { restoreSession: (pid: string, offset: string) => Promise<{ data: unknown } | null> };
     const restore = adapter.restoreSession.bind(adapter);
     // what a Redis or Postgres adapter hands back: the session data as JSON
     adapter.restoreSession = async (pid, offset) => {
       const session = await restore(pid, offset);
       return session && { ...session, data: JSON.parse(JSON.stringify(session.data)) };
     };

     const { id, pid, offset } = await dropped({ auth: { token: 'recov-user' } });
     const { second } = await reconnect(pid, offset, { token: 'recov-user' });
     const hub = DI.resolve(SocketHub);

     expect(second.id).to.equal(id);
     await waitFor(() => hub.connection(id)?.user instanceof RecoveredUser);
     expect((hub.connection(id)!.user as RecoveredUser).greet()).to.equal('hi ann');
   });
   ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/recovery.test.ts`
Expected: FAIL to compile with `Property 'recovered' does not exist on type 'SocketConnection'`.

- [ ] **Step 3: Implement**

In `packages/http-socket/src/connection.ts`, add this field after `public readonly connectedAt: number;`:

```ts
  /** Restored by connection state recovery after a short drop: rooms and `data` survived, and the connect hooks run again. */
  public readonly recovered: boolean;
```

and add this line in the constructor, after `this.connectedAt = Date.now();`:

```ts
    this.recovered = socket.recovered;
```

In `packages/http-socket/src/principal-guard.ts`, add after `ensure()`:

```ts
  /**
   * @internal A recovered connection skipped the handshake, so its principal is checked with its source
   * now, whatever `revalidateMs` says. A session restored through a serializing adapter carries a flattened
   * `Principal.identity`; a 'valid' answer that carries the principal brings the real one back.
   */
  public async recheck(connection: SocketConnection): Promise<void> {
    if (connection.auth.source === null || this.closing.has(connection)) {
      return;
    }

    await (this.pending.get(connection) ?? this.check(connection));
  }
```

In `packages/http-socket/src/dispatcher.ts`, in `attach`, replace `runtime.ready = this.connectHooks(runtime);` with:

```ts
    runtime.ready = connection.recovered ? this.afterRecovery(runtime) : this.connectHooks(runtime);
```

and add after `connectHooks`:

```ts
  /** Commands and hooks of a recovered connection wait for its principal to be checked again. */
  protected async afterRecovery(runtime: IConnectionRuntime): Promise<void> {
    const connection = runtime.connection;

    try {
      await this.Guard.recheck(connection);
    } catch (err) {
      this.Log.error(err as Error, `Socket ${connection.id}: re-checking the principal of a recovered connection failed`);
    }

    if (!this.Guard.isClosing(connection)) {
      await this.connectHooks(runtime);
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/recovery.test.ts test/revalidation.test.ts test/events.test.ts`
Expected: `0 failing`. `recovery.test.ts` reports `8 passing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/connection.ts packages/http-socket/src/principal-guard.ts packages/http-socket/src/dispatcher.ts packages/http-socket/test/recovery.test.ts && \
git commit -m "feat(http-socket): recovered connections carry a flag and re-check their principal before hooks and commands"
```

---

### Task 8: `OutboxStore`, `MemoryOutboxStore` and the store contract suite

**Files:**
- Create: `packages/http-socket-client/src/outbox.ts`
- Create: `packages/http-socket-client/test/support/outbox-contract.ts`
- Test: `packages/http-socket-client/test/outbox.test.ts`

**Interfaces:**
- Consumes: `SocketError` (common).
- Produces:
  - `interface OutboxEntry<P = unknown> { readonly seq: number; readonly name: string; readonly payload: P; readonly key?: string; readonly createdAt: number }`
  - `interface FailedOutboxEntry<P = unknown> extends OutboxEntry<P> { readonly error: SocketError; readonly failedAt: number }`
  - `interface OutboxInput<P = unknown> { name: string; payload: P; key?: string }`
  - `interface OutboxStore`:
    - `add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>>`
    - `pending(): Promise<OutboxEntry[]>`
    - `remove(seq: number): Promise<void>`
    - `fail(entry: FailedOutboxEntry): Promise<void>`: moves pending `entry.seq` to the failed list as `entry`; a no-op when that seq is not pending
    - `failed(): Promise<FailedOutboxEntry[]>`
    - `clearFailed(seqs?: readonly number[]): Promise<void>`
  - `class MemoryOutboxStore implements OutboxStore`
  - test-only: `describeOutboxStore(title: string, fixture: () => OutboxStoreFixture, options: { reopens: boolean }): void` and `interface OutboxStoreFixture { create(): Promise<OutboxStore>; reopen?(): Promise<OutboxStore> }`. Tasks 11 and 12 run their stores through it.

- [ ] **Step 1: Write the contract suite and the failing test**

Create `packages/http-socket-client/test/support/outbox-contract.ts`:

```ts
import { expect } from 'chai';
import type { SocketError } from '@spinajs/http-socket-common';
import type { FailedOutboxEntry, OutboxEntry, OutboxStore } from '../../src/outbox.js';

export interface OutboxStoreFixture {
  /** A fresh, empty store. */
  create(): Promise<OutboxStore>;
  /** A new instance over the storage of the last `create()`. */
  reopen?(): Promise<OutboxStore>;
}

const CONFLICT: SocketError = { code: 'conflict', message: 'already there', retryable: false };

function failedOf(entry: OutboxEntry): FailedOutboxEntry {
  return { ...entry, error: CONFLICT, failedAt: 1_000 };
}

/** Every OutboxStore passes this suite; `fixture` is called once per test. */
export function describeOutboxStore(title: string, fixture: () => OutboxStoreFixture, options: { reopens: boolean }): void {
  describe(`${title} ( OutboxStore contract )`, () => {
    let f: OutboxStoreFixture;
    let store: OutboxStore;

    beforeEach(async () => {
      f = fixture();
      store = await f.create();
    });

    it('assigns increasing seqs and lists pending entries in seq order', async () => {
      const a = await store.add({ name: 'docs.submit', payload: { n: 1 } });
      const b = await store.add({ name: 'docs.submit', payload: { n: 2 } });
      const c = await store.add({ name: 'blob.put', payload: { n: 3 } });

      expect(a.seq).to.be.below(b.seq);
      expect(b.seq).to.be.below(c.seq);
      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([a.seq, b.seq, c.seq]);
    });

    it('keeps the name, the payload, an app key and the creation time', async () => {
      const before = Date.now();
      const entry = await store.add({ name: 'docs.submit', payload: { op: { id: 'o1', keys: ['a', 'b'] } }, key: 'op-o1' });
      const [stored] = await store.pending();

      expect(stored).to.deep.equal(entry);
      expect(stored).to.include({ name: 'docs.submit', key: 'op-o1' });
      expect(stored.payload).to.deep.equal({ op: { id: 'o1', keys: ['a', 'b'] } });
      expect(stored.createdAt).to.be.at.least(before);
    });

    it('leaves the key out when the app gave none', async () => {
      await store.add({ name: 'x', payload: null });

      expect((await store.pending())[0]).to.not.have.property('key');
    });

    it('removes an acknowledged entry and ignores unknown seqs', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      const b = await store.add({ name: 'x', payload: 2 });

      await store.remove(a.seq);
      await store.remove(9_999);

      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([b.seq]);
    });

    it('never reuses a seq, even after the newest entry was removed', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      await store.remove(a.seq);
      const b = await store.add({ name: 'x', payload: 2 });

      expect(b.seq).to.be.above(a.seq);
    });

    it('moves a pending entry to the failed list', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      const b = await store.add({ name: 'x', payload: 2 });

      await store.fail(failedOf(a));

      expect((await store.pending()).map((e) => e.seq)).to.deep.equal([b.seq]);
      expect(await store.failed()).to.deep.equal([failedOf(a)]);
    });

    it('ignores fail() for an entry that is not pending', async () => {
      const a = await store.add({ name: 'x', payload: 1 });
      await store.remove(a.seq);

      await store.fail(failedOf(a));

      expect(await store.failed()).to.deep.equal([]);
    });

    it('lists failed entries in seq order and clears some or all of them', async () => {
      const entries = [await store.add({ name: 'x', payload: 1 }), await store.add({ name: 'x', payload: 2 }), await store.add({ name: 'x', payload: 3 })];
      for (const entry of [...entries].reverse()) {
        await store.fail(failedOf(entry));
      }

      expect((await store.failed()).map((e) => e.seq)).to.deep.equal(entries.map((e) => e.seq));
      await store.clearFailed([entries[1].seq]);
      expect((await store.failed()).map((e) => e.seq)).to.deep.equal([entries[0].seq, entries[2].seq]);
      await store.clearFailed();
      expect(await store.failed()).to.deep.equal([]);
    });

    if (options.reopens) {
      it('keeps pending entries, failed entries and the seq counter across a reopen', async () => {
        const a = await store.add({ name: 'x', payload: { n: 1 }, key: 'k1' });
        const b = await store.add({ name: 'x', payload: { n: 2 } });
        const c = await store.add({ name: 'x', payload: { n: 3 } });
        await store.fail(failedOf(a));
        await store.remove(c.seq);

        const reopened = await f.reopen!();

        expect(await reopened.pending()).to.deep.equal([b]);
        expect(await reopened.failed()).to.deep.equal([failedOf(a)]);
        const d = await reopened.add({ name: 'x', payload: { n: 4 } });
        expect(d.seq).to.be.above(c.seq);
      });
    }
  });
}
```

Create `packages/http-socket-client/test/outbox.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { MemoryOutboxStore } from '../src/outbox.js';
import { describeOutboxStore } from './support/outbox-contract.js';

describeOutboxStore('MemoryOutboxStore', () => ({ create: async () => new MemoryOutboxStore() }), { reopens: false });

describe('MemoryOutboxStore', () => {
  it('hands out copies of its lists, so a caller cannot reorder the queue', async () => {
    const store = new MemoryOutboxStore();
    await store.add({ name: 'x', payload: 1 });

    (await store.pending()).length = 0;

    expect(await store.pending()).to.have.length(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/outbox.test.ts`
Expected: FAIL with `Cannot find module '../src/outbox.js'`.

- [ ] **Step 3: Implement**

Create `packages/http-socket-client/src/outbox.ts`:

```ts
import type { SocketError } from '@spinajs/http-socket-common';

/** A durable command waiting for its reply. */
export interface OutboxEntry<P = unknown> {
  /** Queue position: assigned by the store, strictly increasing, never reused. */
  readonly seq: number;
  readonly name: string;
  readonly payload: P;
  /** Idempotency key chosen by the app; `clientId:<random nonce persisted with the entry>` when absent ( spec amendment, RELEASE_NOTES ). */
  readonly key?: string;
  /** ms epoch */
  readonly createdAt: number;
}

/** An entry the server refused for good; it stays until the app clears it. */
export interface FailedOutboxEntry<P = unknown> extends OutboxEntry<P> {
  readonly error: SocketError;
  /** ms epoch */
  readonly failedAt: number;
}

export interface OutboxInput<P = unknown> {
  name: string;
  payload: P;
  key?: string;
}

/**
 * Where durable commands wait for their reply. Every method resolves only once its change is durable
 * in the store's medium: the queue sends a command after `add` resolved. One SocketClient at a time per store.
 */
export interface OutboxStore {
  add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>>;
  /** Entries not yet acknowledged, ascending `seq`. */
  pending(): Promise<OutboxEntry[]>;
  /** Removes an acknowledged entry; an unknown seq is ignored. */
  remove(seq: number): Promise<void>;
  /** Moves the pending entry `entry.seq` to the failed list as `entry`; ignored when that seq is not pending. */
  fail(entry: FailedOutboxEntry): Promise<void>;
  /** The failed list, ascending `seq`: export it before clearing it. */
  failed(): Promise<FailedOutboxEntry[]>;
  /** Removes failed entries; all of them when `seqs` is omitted. */
  clearFailed(seqs?: readonly number[]): Promise<void>;
}

/** Keeps nothing across reloads: the default when no store is given. */
export class MemoryOutboxStore implements OutboxStore {
  private seq = 0;
  private readonly entries = new Map<number, OutboxEntry>();
  private readonly failures = new Map<number, FailedOutboxEntry>();

  public async add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    const entry: OutboxEntry<P> = { seq: ++this.seq, name: input.name, payload: input.payload, createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
    this.entries.set(entry.seq, entry);
    return entry;
  }

  public async pending(): Promise<OutboxEntry[]> {
    return [...this.entries.values()];
  }

  public async remove(seq: number): Promise<void> {
    this.entries.delete(seq);
  }

  public async fail(entry: FailedOutboxEntry): Promise<void> {
    if (this.entries.delete(entry.seq)) {
      this.failures.set(entry.seq, entry);
    }
  }

  public async failed(): Promise<FailedOutboxEntry[]> {
    return [...this.failures.values()].sort((a, b) => a.seq - b.seq);
  }

  public async clearFailed(seqs?: readonly number[]): Promise<void> {
    if (seqs === undefined) {
      this.failures.clear();
      return;
    }

    for (const seq of seqs) {
      this.failures.delete(seq);
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/outbox.test.ts test/isomorphic.test.ts`
Expected: `11 passing`: 8 contract, 1 memory and 2 isomorphic.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/outbox.ts packages/http-socket-client/test/support/outbox-contract.ts packages/http-socket-client/test/outbox.test.ts && \
git commit -m "feat(http-socket-client): OutboxStore contract and MemoryOutboxStore"
```

---

### Task 9: `DurableQueue`

**Files:**
- Create: `packages/http-socket-client/src/durable.ts`
- Create: `packages/http-socket-client/test/support/durable.ts`
- Test: `packages/http-socket-client/test/durable.test.ts`

**Interfaces:**
- Consumes:
  - `Connection`: `events.on('state')`, `connected`, `request(event, data, onReply)`
  - `CommandDispatcher.nextId()`: the single request-id space
  - `ReconnectPolicy.delay(attempt, retryAfterMs)`, `Emitter`, `rethrowAsync`, `assertTimeoutMs`
  - `OutboxStore` (Task 8); `isKey`, `MAX_KEY_LENGTH`, `CommandRequest.after` (Task 1)
  - the stub's `rawReplies`, `ackFault`, `killConnections`, `refuse`, `requests`
- Produces:
  - `class DurableQueue`:
    - `constructor(options: DurableQueueOptions)`
    - `readonly events: Emitter<DurableEvents>`
    - `submit(name: string, payload: unknown, options?: DurableCommandOptions): Promise<unknown>`
    - `close(): void`
    - `size: number`
  - `interface DurableQueueOptions { connection: Connection; commands: CommandDispatcher; store: OutboxStore; clientId: string; reconnect?: Partial<ReconnectOptions>; durable?: DurableOptions; onListenerError?: (error: unknown) => void }`
  - `interface DurableOptions { window?: number; ackTimeoutMs?: number }` and `DEFAULT_DURABLE = { window: 16, ackTimeoutMs: 60_000 }`
  - `interface DurableCommandOptions { key?: string }`
  - `interface DurableEvents { acked: (event: AckedCommand) => void; failed: (event: FailedCommand) => void }`
  - `interface AckedCommand { entry: OutboxEntry; result: unknown }`
  - `interface FailedCommand { entry: FailedOutboxEntry; error: SocketError }`
  - test-only:
    - `serveDurable(server, name, handler?, options?: { refuse?: (request: CommandRequest) => SocketError | undefined }): DurableStub`, where `DurableStub = { runs: Map<string, number>; order: string[]; completed: Map<string, CommandReply> }`
    - `onlineQueue(server, options?): Promise<{ connection; queue; store }>`

- [ ] **Step 1: Write the stub behaviour and the failing tests**

Create `packages/http-socket-client/test/support/durable.ts`:

```ts
import { isSocketError, type CommandReply, type CommandRequest, type SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { DurableQueue, type DurableQueueOptions } from '../../src/durable.js';
import { MemoryOutboxStore, type OutboxStore } from '../../src/outbox.js';
import { track } from './cleanup.js';
import { FAST_RECONNECT, makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { waitForState } from './wait.js';

export interface DurableStub {
  /** handler runs by idempotency key */
  readonly runs: Map<string, number>;
  /** idempotency keys in the order their handler ran */
  readonly order: string[];
  /** final replies by key; replays answer with them */
  readonly completed: Map<string, CommandReply>;
}

export interface DurableStubOptions {
  /** A refusal from a stage before idempotency ( authentication, limits ): never stored. */
  refuse?: (request: CommandRequest) => SocketError | undefined;
}

const INTERNAL: SocketError = { code: 'internal', message: 'handler failed', retryable: false };

/**
 * Answers `name` as the W3 server answers a durable command: one run per idempotency key, replays of
 * final replies, retryable failures released, and the `after` fence. Keys are not scoped by client:
 * one client per test.
 */
export function serveDurable(server: StubServer, name: string, handler: (payload: any, request: CommandRequest) => unknown = (payload) => payload, options: DurableStubOptions = {}): DurableStub {
  const stub: DurableStub = { runs: new Map(), order: [], completed: new Map() };

  server.rawReplies.set(name, async (request: CommandRequest): Promise<CommandReply> => {
    const refusal = options.refuse?.(request);
    if (refusal) {
      return { id: request.id, ok: false, error: refusal };
    }

    const key = request.idempotencyKey;
    if (key === undefined) {
      return { id: request.id, ok: false, error: { code: 'invalid_argument', message: 'durable test commands need a key', retryable: false } };
    }

    const done = stub.completed.get(key);
    if (done) {
      return { ...done, id: request.id };
    }

    if (request.after !== undefined && !stub.completed.has(request.after)) {
      return { id: request.id, ok: false, error: { code: 'unavailable', message: `${request.after} has not completed`, retryable: true } };
    }

    stub.runs.set(key, (stub.runs.get(key) ?? 0) + 1);
    stub.order.push(key);

    let reply: CommandReply;
    try {
      const result = await handler(request.payload, request);
      reply = { id: request.id, ok: true, result: result === undefined ? null : result };
    } catch (error) {
      const wire = isSocketError(error) ? error : INTERNAL;
      if (wire.retryable) {
        return { id: request.id, ok: false, error: wire };
      }
      reply = { id: request.id, ok: false, error: wire };
    }

    stub.completed.set(key, reply);
    return reply;
  });

  return stub;
}

export async function onlineQueue(server: StubServer, options: Partial<DurableQueueOptions> = {}): Promise<{ connection: Connection; queue: DurableQueue; store: OutboxStore }> {
  const connection = makeConnection(server);
  const store = options.store ?? new MemoryOutboxStore();
  const queue = track(new DurableQueue({ connection, commands: new CommandDispatcher(connection, 1000), store, clientId: 'client-1', reconnect: FAST_RECONNECT, ...options }));
  connection.connect();
  await waitForState(statefulConnection(connection), 'online');
  return { connection, queue, store };
}
```

Create `packages/http-socket-client/test/durable.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { CommandRequest, SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../src/commands.js';
import { DEFAULT_DURABLE, DurableQueue, type AckedCommand, type FailedCommand } from '../src/durable.js';
import { MemoryOutboxStore, type OutboxInput, type OutboxStore } from '../src/outbox.js';
import { closeAll, track } from './support/cleanup.js';
import { rejectionOf } from './support/commands.js';
import { FAST_RECONNECT, makeConnection } from './support/connection.js';
import { onlineQueue, serveDurable } from './support/durable.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, until } from './support/wait.js';

describe('DurableQueue', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  const fresh = (store: OutboxStore = new MemoryOutboxStore()) => {
    const connection = makeConnection(server);
    const queue = track(new DurableQueue({ connection, commands: new CommandDispatcher(connection, 1000), store, clientId: 'client-1', reconnect: FAST_RECONNECT }));
    return { connection, queue };
  };

  it('ships the spec defaults', () => {
    expect(DEFAULT_DURABLE).to.deep.equal({ window: 16, ackTimeoutMs: 60_000 });
  });

  it('sends in order, keyed clientId:nonce, each after the previous unacknowledged command, without a deadline', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 100 };
    const { queue } = await onlineQueue(server);

    const results = await Promise.all([1, 2, 3].map((n) => queue.submit('docs.submit', { n })));

    expect(results).to.deep.equal([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(server.requests.map((r) => [r.idempotencyKey, r.after])).to.deep.equal([
      ['client-1:1', undefined],
      ['client-1:2', 'client-1:1'],
      ['client-1:3', 'client-1:2'],
    ]);
    expect(server.requests.every((r) => r.deadline === undefined)).to.be.true;
  });

  it('keeps at most window commands unanswered', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 200 };
    const { queue } = await onlineQueue(server, { durable: { window: 3 } });

    const all = Promise.all(Array.from({ length: 7 }, (_, n) => queue.submit('docs.submit', { n })));
    await sleep(100);
    expect(server.requests).to.have.length(3);

    await all;
    expect(server.requests).to.have.length(7);
  });

  it('writes a command to the store before it sends it', async () => {
    serveDurable(server, 'docs.submit');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const store = new MemoryOutboxStore();
    const add = store.add.bind(store);
    store.add = (async (input: OutboxInput) => {
      await gate;
      return add(input);
    }) as OutboxStore['add'];
    const { queue } = await onlineQueue(server, { store });

    const done = queue.submit('docs.submit', { n: 1 });
    await sleep(100);
    expect(server.requests).to.have.length(0);

    release();
    expect(await done).to.deep.equal({ n: 1 });
    await sleep(20);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('resends what was not acknowledged after a drop; each command runs once and settles in order', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 150 };
    const { queue } = await onlineQueue(server);
    const settled: number[] = [];

    const all = Promise.all([1, 2, 3, 4].map((n) => queue.submit('docs.submit', { n }).then(() => settled.push(n))));
    await until(() => stub.runs.size === 4);
    // the four replies are still delayed: they die with the transport
    server.killConnections();
    server.ackFault = { kind: 'none' };
    await all;

    expect(settled).to.deep.equal([1, 2, 3, 4]);
    expect([...stub.runs.values()]).to.deep.equal([1, 1, 1, 1]);
    expect(server.requests.length).to.be.above(4);
  });

  it('retries a retryable refusal after a backoff that honours retryAfterMs', async () => {
    let refusals = 2;
    serveDurable(server, 'docs.submit', (payload) => {
      if (refusals-- > 0) {
        throw { code: 'resource_exhausted', message: 'busy', retryable: true, retryAfterMs: 30 } as SocketError;
      }
      return payload;
    });
    const { queue } = await onlineQueue(server);
    const started = Date.now();

    expect(await queue.submit('docs.submit', { n: 1 })).to.deep.equal({ n: 1 });
    expect(server.requests).to.have.length(3);
    expect(Date.now() - started).to.be.at.least(60);
  });

  it('moves a command refused for good to the failed list, emits failed, and goes on with the next one', async () => {
    serveDurable(server, 'docs.submit', (payload: { n: number }) => {
      if (payload.n === 2) {
        throw { code: 'invalid_argument', message: 'malformed op', retryable: false } as SocketError;
      }
      return payload;
    });
    const store = new MemoryOutboxStore();
    const { queue } = await onlineQueue(server, { store });
    const failed: FailedCommand[] = [];
    queue.events.on('failed', (event) => failed.push(event));

    const [one, two, three] = [1, 2, 3].map((n) => queue.submit('docs.submit', { n }));
    const error = await rejectionOf(two);

    expect(await one).to.deep.equal({ n: 1 });
    expect(await three).to.deep.equal({ n: 3 });
    expect(error.code).to.equal('invalid_argument');
    expect(failed).to.have.length(1);
    expect(failed[0].entry).to.include({ seq: 2, name: 'docs.submit' });
    expect(failed[0].error.code).to.equal('invalid_argument');
    await sleep(20);
    expect((await store.failed()).map((e) => e.seq)).to.deep.equal([2]);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('keeps a command whose credentials ran out queued instead of failing it', async () => {
    let expired = true;
    const stub = serveDurable(server, 'docs.submit', undefined, { refuse: () => (expired ? { code: 'unauthenticated', message: 'credentials expired', retryable: false } : undefined) });
    const { queue } = await onlineQueue(server);
    const failed: FailedCommand[] = [];
    queue.events.on('failed', (event) => failed.push(event));

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length >= 1);
    await sleep(50);
    expired = false;

    expect(await done).to.deep.equal({ n: 1 });
    expect(failed).to.deep.equal([]);
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('resumes the entries a previous queue left in the store and reports them through acked', async () => {
    const stub = serveDurable(server, 'docs.submit');
    const store = new MemoryOutboxStore();
    await store.add({ name: 'docs.submit', payload: { n: 1 } });
    await store.add({ name: 'docs.submit', payload: { n: 2 }, key: 'op-2' });
    const acked: AckedCommand[] = [];

    const { connection, queue } = fresh(store);
    queue.events.on('acked', (event) => acked.push(event));
    connection.connect();
    await until(() => acked.length === 2);

    expect(acked.map((a) => [a.entry.seq, a.result])).to.deep.equal([
      [1, { n: 1 }],
      [2, { n: 2 }],
    ]);
    expect(stub.order).to.deep.equal(['client-1:1', 'op-2']);
    expect(server.requests[1].after).to.equal('client-1:1');
    await sleep(20);
    expect(await store.pending()).to.deep.equal([]);
  });

  it('rejects waiting callers on close but keeps their entries in the store', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const { queue, store } = await onlineQueue(server);

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    queue.close();
    const error = await rejectionOf(done);

    expect(error.code).to.equal('unavailable');
    expect(error.retryable).to.be.false;
    expect((await store.pending()).map((e) => e.seq)).to.deep.equal([1]);
    expect((await rejectionOf(queue.submit('docs.submit', {}))).code).to.equal('unavailable');
  });

  it('sends a command again when its reply does not come within ackTimeoutMs', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const { queue } = await onlineQueue(server, { durable: { ackTimeoutMs: 150 } });

    const done = queue.submit('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    server.ackFault = { kind: 'none' };

    expect(await done).to.deep.equal({ n: 1 });
    expect(server.requests).to.have.length(2);
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('uses an app key verbatim and refuses one the server would refuse', async () => {
    serveDurable(server, 'docs.submit');
    const { queue } = await onlineQueue(server);

    await queue.submit('docs.submit', { n: 1 }, { key: 'op-1' });
    expect(server.requests[0].idempotencyKey).to.equal('op-1');

    for (const key of ['', 'a b', 'k'.repeat(257)]) {
      const error = await queue.submit('docs.submit', {}, { key }).catch((e: unknown) => e);
      expect(error, key).to.be.instanceOf(RangeError);
    }
  });

  it('waits through a refused connection and sends once the app connects again', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.refuse = () => ({ code: 'forbidden', message: 'not now', retryable: false });
    const { connection, queue } = fresh();
    const refused = nextEmit((listener) => connection.events.on('refused', listener));
    connection.connect();
    await refused;

    const done = queue.submit('docs.submit', { n: 1 });
    await sleep(100);
    expect(server.requests).to.have.length(0);

    server.refuse = undefined;
    connection.connect();
    expect(await done).to.deep.equal({ n: 1 });
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('settles callers in send order even when the replies arrive out of order', async () => {
    server.rawReplies.set('docs.slow', async (request: CommandRequest) => {
      if (request.idempotencyKey === 'client-1:1') {
        await sleep(150);
      }
      return { id: request.id, ok: true, result: request.payload };
    });
    const { queue } = await onlineQueue(server);
    const settled: number[] = [];

    await Promise.all([1, 2, 3].map((n) => queue.submit('docs.slow', { n }).then(() => settled.push(n))));

    expect(settled).to.deep.equal([1, 2, 3]);
  });

  it('validates its options', () => {
    const connection = makeConnection(server);
    const base = { connection, commands: new CommandDispatcher(connection, 1000), store: new MemoryOutboxStore(), clientId: 'client-1' };

    expect(() => new DurableQueue({ ...base, durable: { window: 0 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, durable: { window: 1.5 } })).to.throw(RangeError);
    expect(() => new DurableQueue({ ...base, durable: { ackTimeoutMs: 0 } })).to.throw(RangeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/durable.test.ts`
Expected: FAIL with `Cannot find module '../src/durable.js'`.

- [ ] **Step 3: Implement**

Create `packages/http-socket-client/src/durable.ts`:

```ts
import { MAX_KEY_LENGTH, SocketException, WIRE_EVENTS, isKey, isSocketError, type CommandReply, type CommandRequest, type SocketError } from '@spinajs/http-socket-common';
import type { CommandDispatcher } from './commands.js';
import type { Connection, ConnectionState } from './connection.js';
import { Emitter, rethrowAsync } from './emitter.js';
import type { FailedOutboxEntry, OutboxEntry, OutboxStore } from './outbox.js';
import { ReconnectPolicy, type ReconnectOptions } from './reconnect.js';
import { assertTimeoutMs } from './timeout.js';

export interface DurableOptions {
  /** Durable commands sent and not yet answered at once. */
  window?: number;
  /** A command unanswered this long on a live connection is sent again; the server replays or joins it. */
  ackTimeoutMs?: number;
}

export interface DurableCommandOptions {
  /** Idempotency key, eg. an op id; `clientId:<random nonce persisted with the entry>` when omitted ( spec amendment, RELEASE_NOTES ). 1-MAX_KEY_LENGTH printable ASCII characters. */
  key?: string;
}

export const DEFAULT_DURABLE: Readonly<Required<DurableOptions>> = Object.freeze({ window: 16, ackTimeoutMs: 60_000 });

export interface AckedCommand {
  entry: OutboxEntry;
  result: unknown;
}

export interface FailedCommand {
  entry: FailedOutboxEntry;
  error: SocketError;
}

export interface DurableEvents {
  acked: (event: AckedCommand) => void;
  failed: (event: FailedCommand) => void;
}

export interface DurableQueueOptions {
  connection: Connection;
  commands: CommandDispatcher;
  store: OutboxStore;
  clientId: string;
  reconnect?: Partial<ReconnectOptions>;
  durable?: DurableOptions;
  /** Gets listener errors, and store failures that no durable() call can reject with. */
  onListenerError?: (error: unknown) => void;
}

const CLOSED: SocketError = { code: 'unavailable', message: 'the client is closed; the command stays in the outbox', retryable: false };
const STREAM_REPLY: SocketError = { code: 'failed_precondition', message: 'a durable command cannot reply with a stream', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };

type Timer = ReturnType<typeof setTimeout>;
type Outcome = { ok: true; result: unknown } | { ok: false; failed: FailedOutboxEntry };

interface Item {
  readonly entry: OutboxEntry;
  readonly key: string;
  state: 'queued' | 'sent' | 'done';
  /** the request whose reply counts; null while queued */
  requestId: string | null;
  timer: Timer | undefined;
  outcome?: Outcome;
  resolve?: (result: unknown) => void;
  reject?: (error: SocketException) => void;
}

/**
 * Durable commands ( spec §6 ): persisted before they are sent, sent in order up to a window, sent
 * again after any drop, and settled in send order. The server runs each key once and runs a command
 * only after the one named in its `after`, so a resend never runs twice and never overtakes.
 */
export class DurableQueue {
  public readonly events: Emitter<DurableEvents>;
  private readonly items: Item[] = [];
  private readonly policy: ReconnectPolicy;
  private readonly window: number;
  private readonly ackTimeoutMs: number;
  private readonly onStoreError: (error: unknown) => void;
  private readonly loaded: Promise<void>;
  private adding: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private pausedUntil = 0;
  private pauseTimer: Timer | undefined;
  private closed = false;

  constructor(private readonly options: DurableQueueOptions) {
    const { window, ackTimeoutMs } = { ...DEFAULT_DURABLE, ...options.durable };
    if (!(Number.isInteger(window) && window >= 1)) {
      throw new RangeError(`durable.window must be an integer of at least 1, got ${window}`);
    }
    this.window = window;
    this.ackTimeoutMs = assertTimeoutMs('durable.ackTimeoutMs', ackTimeoutMs);
    this.policy = new ReconnectPolicy(options.reconnect);
    this.onStoreError = options.onListenerError ?? rethrowAsync;
    this.events = new Emitter<DurableEvents>(options.onListenerError);
    options.connection.events.on('state', (state, previous) => this.onState(state, previous));
    this.loaded = this.load();
    this.loaded.catch(this.onStoreError);
  }

  /** Commands not yet settled to their callers, resumed ones included. */
  public get size(): number {
    return this.items.length;
  }

  public submit(name: string, payload: unknown, options: DurableCommandOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(SocketException.fromWire(CLOSED));
    }

    if (options.key !== undefined && !isKey(options.key)) {
      return Promise.reject(new RangeError(`a durable command key must be 1-${MAX_KEY_LENGTH} printable ASCII characters`));
    }

    // one add at a time: the queue then holds its items in seq order before any of them is sent
    const added = this.adding.then(async () => {
      await this.loaded;
      return this.options.store.add({ name, payload, ...(options.key !== undefined ? { key: options.key } : {}) });
    });
    this.adding = added.catch(() => undefined);

    return added.then(
      (entry) =>
        new Promise<unknown>((resolve, reject) => {
          // persisted already: it resumes on the next start
          if (this.closed) {
            reject(SocketException.fromWire(CLOSED));
            return;
          }

          const item = this.item(entry);
          item.resolve = resolve;
          item.reject = reject;
          this.items.push(item);
          this.pump();
        }),
    );
  }

  /** Rejects the callers still waiting; their entries stay in the store for the next start. */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    clearTimeout(this.pauseTimer);

    for (const item of this.items.splice(0)) {
      clearTimeout(item.timer);
      const outcome = item.outcome;
      if (outcome?.ok) {
        item.resolve?.(outcome.result);
      } else {
        item.reject?.(SocketException.fromWire(outcome ? outcome.failed.error : CLOSED));
      }
    }
  }

  private async load(): Promise<void> {
    const entries = await this.options.store.pending();
    if (this.closed) {
      return;
    }

    this.items.push(...entries.map((entry) => this.item(entry)));
    this.pump();
  }

  private item(entry: OutboxEntry): Item {
    return { entry, key: entry.key ?? `${this.options.clientId}:${entry.seq}`, state: 'queued', requestId: null, timer: undefined };
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      this.close();
      return;
    }

    // their replies can no longer arrive; the server joins or replays the resend
    if (previous === 'online') {
      for (const item of this.items) {
        if (item.state === 'sent') {
          this.requeue(item);
        }
      }
    }

    if (state === 'online') {
      this.pump();
    }
  }

  private pump(): void {
    if (this.closed || !this.options.connection.connected || Date.now() < this.pausedUntil) {
      return;
    }

    let unanswered = this.items.filter((item) => item.state === 'sent').length;
    let previous: Item | undefined;

    for (const item of this.items) {
      if (item.state === 'done') {
        continue;
      }

      if (item.state === 'queued') {
        if (unanswered >= this.window || !this.transmit(item, previous)) {
          return;
        }
        unanswered++;
      }

      previous = item;
    }
  }

  private transmit(item: Item, previous: Item | undefined): boolean {
    const request: CommandRequest = { id: this.options.commands.nextId(), name: item.entry.name, payload: item.entry.payload, idempotencyKey: item.key };
    // the server runs it only once its predecessor completed, so neither a resend nor a refusal lets it overtake
    if (previous) {
      request.after = previous.key;
    }

    item.state = 'sent';
    item.requestId = request.id;
    item.timer = setTimeout(() => this.onAckTimeout(item, request.id), this.ackTimeoutMs);

    if (this.options.connection.request<CommandReply>(WIRE_EVENTS.command, request, (reply) => this.onReply(item, request.id, reply))) {
      return true;
    }

    this.requeue(item);
    return false;
  }

  private onReply(item: Item, id: string, reply: CommandReply): void {
    // a later send replaced this request, or the connection dropped before the reply
    if (item.requestId !== id) {
      return;
    }

    clearTimeout(item.timer);
    item.timer = undefined;
    item.requestId = null;

    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') {
      return this.fail(item, MALFORMED_REPLY);
    }

    if (!reply.ok) {
      const error = isSocketError(reply.error) ? reply.error : MALFORMED_REPLY;
      // unauthenticated: the credentials ran out, not the command; it waits for the next connection
      return error.retryable || error.code === 'unauthenticated' ? this.retry(item, error) : this.fail(item, error);
    }

    if ('stream' in reply) {
      return this.fail(item, STREAM_REPLY);
    }

    this.succeed(item, reply.result);
  }

  private onAckTimeout(item: Item, id: string): void {
    if (item.requestId !== id) {
      return;
    }

    this.requeue(item);
    this.pump();
  }

  private requeue(item: Item): void {
    clearTimeout(item.timer);
    item.timer = undefined;
    item.requestId = null;
    item.state = 'queued';
  }

  /** One backoff for the whole queue: its commands are refused for shared reasons ( overload, shutdown, a predecessor ). */
  private retry(item: Item, error: SocketError): void {
    this.requeue(item);

    const now = Date.now();
    if (now < this.pausedUntil) {
      return;
    }

    this.pausedUntil = now + this.policy.delay(this.attempt++, error.retryAfterMs);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      this.pausedUntil = 0;
      this.pump();
    }, this.pausedUntil - now);
  }

  private succeed(item: Item, result: unknown): void {
    this.attempt = 0;
    item.state = 'done';
    item.outcome = { ok: true, result };
    this.options.store.remove(item.entry.seq).catch(this.onStoreError);
    this.settle();
    this.pump();
  }

  private fail(item: Item, error: SocketError): void {
    const failed: FailedOutboxEntry = { ...item.entry, error, failedAt: Date.now() };
    item.state = 'done';
    item.outcome = { ok: false, failed };
    this.options.store.fail(failed).catch(this.onStoreError);
    this.settle();
    this.pump();
  }

  /** Callers and listeners hear about commands in send order, whatever order their replies came in. */
  private settle(): void {
    while (this.items[0]?.state === 'done') {
      const item = this.items.shift()!;
      const outcome = item.outcome!;

      if (outcome.ok) {
        item.resolve?.(outcome.result);
        this.events.emit('acked', { entry: item.entry, result: outcome.result });
      } else {
        item.reject?.(SocketException.fromWire(outcome.failed.error));
        this.events.emit('failed', { entry: outcome.failed, error: outcome.failed.error });
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/durable.test.ts test/isomorphic.test.ts && npm run typecheck`
Expected: `17 passing` (15 durable, 2 isomorphic), then a typecheck with no output.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/durable.ts packages/http-socket-client/test/support/durable.ts packages/http-socket-client/test/durable.test.ts && \
git commit -m "feat(http-socket-client): durable queue: persisted, pipelined, resent after drops, settled in order"
```

---

### Task 10: `SocketClient.durable()`, the `outbox` option and the `acked` / `failed` lifecycle events

**Files:**
- Modify: `packages/http-socket-client/src/client.ts`
- Modify: `packages/http-socket-client/src/contract.ts`
- Modify: `packages/http-socket-client/src/index.ts` (whole file, below)
- Modify: `packages/http-socket-client/test/client.test.ts` (the "reserves durable() and stream()" test)
- Modify: `packages/http-socket-client/test/index.test.ts`
- Test: `packages/http-socket-client/test/durable-client.test.ts`

**Interfaces:**
- Consumes: `DurableQueue`, `DurableOptions`, `DurableCommandOptions`, `AckedCommand`, `FailedCommand` (Task 9); `MemoryOutboxStore`, `OutboxStore` (Task 8).
- Produces:
  - `SocketClientOptions.outbox?: OutboxStore` (a `MemoryOutboxStore` when omitted) and `SocketClientOptions.durable?: DurableOptions`
  - `SocketClient.durable<R>(name: string, payload?: unknown, options?: DurableCommandOptions): Promise<R>`
  - `ClientLifecycleEvents.acked: (event: AckedCommand) => void` and `ClientLifecycleEvents.failed: (event: FailedCommand) => void`
  - `LIFECYCLE_EVENTS` gains `'acked'`
  - `TypedSocketClient.durable<N>(name: N, payload: CommandPayload<C, N>, options?: DurableCommandOptions): Promise<CommandResult<C, N>>`
  - public entry: `MemoryOutboxStore`, `DEFAULT_DURABLE`, and the types `OutboxStore`, `OutboxEntry`, `FailedOutboxEntry`, `OutboxInput`, `DurableOptions`, `DurableCommandOptions`, `AckedCommand`, `FailedCommand`

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket-client/test/durable-client.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { defineContract, type SocketError } from '@spinajs/http-socket-common';
import { LIFECYCLE_EVENTS } from '../src/client.js';
import type { AckedCommand, FailedCommand } from '../src/durable.js';
import { MemoryOutboxStore } from '../src/outbox.js';
import { closeAll } from './support/cleanup.js';
import { makeClient } from './support/client.js';
import { rejectionOf } from './support/commands.js';
import { serveDurable } from './support/durable.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

type DurableContract = {
  commands: { 'docs.submit': [{ n: number }, { seq: number }] };
  events: Record<string, never>;
};

describe('SocketClient durable commands', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('runs durable commands through a MemoryOutboxStore by default', async () => {
    const stub = serveDurable(server, 'docs.submit', (payload: { n: number }) => ({ seq: payload.n * 10 }));
    const client = makeClient(server);

    expect(await client.durable('docs.submit', { n: 1 })).to.deep.equal({ seq: 10 });
    expect(server.requests[0].idempotencyKey).to.equal('client-1:1');
    expect(stub.runs.get('client-1:1')).to.equal(1);
  });

  it('resumes the given outbox and reports resumed commands through acked', async () => {
    serveDurable(server, 'docs.submit');
    const outbox = new MemoryOutboxStore();
    await outbox.add({ name: 'docs.submit', payload: { n: 7 } });
    const acked: AckedCommand[] = [];

    const client = makeClient(server, { outbox, autoConnect: false });
    client.on('acked', (event) => acked.push(event));
    client.connect();
    await until(() => acked.length === 1);

    expect(acked[0].entry.seq).to.equal(1);
    expect(acked[0].result).to.deep.equal({ n: 7 });
  });

  it('emits failed with the stored entry for a command refused for good', async () => {
    serveDurable(server, 'docs.submit', () => {
      throw { code: 'invalid_argument', message: 'malformed op', retryable: false } as SocketError;
    });
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox });
    const failed: FailedCommand[] = [];
    client.on('failed', (event) => failed.push(event));

    const error = await rejectionOf(client.durable('docs.submit', { n: 1 }));

    expect(error.code).to.equal('invalid_argument');
    expect(failed).to.have.length(1);
    expect(failed[0].entry).to.include({ seq: 1, name: 'docs.submit' });
    // the store write runs beside the settlement
    await sleep(20);
    expect((await outbox.failed()).map((e) => e.error.code)).to.deep.equal(['invalid_argument']);
  });

  it('takes the window and an app key', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 150 };
    const client = makeClient(server, { durable: { window: 1 } });

    const both = Promise.all([client.durable('docs.submit', { n: 1 }, { key: 'op-1' }), client.durable('docs.submit', { n: 2 })]);
    await until(() => server.requests.length === 1);
    await sleep(50);
    expect(server.requests).to.have.length(1);
    await both;

    expect(server.requests.map((r) => r.idempotencyKey)).to.deep.equal(['op-1', 'client-1:2']);
  });

  it('rejects waiting durable commands with unavailable on close, keeping them in the outbox', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox });

    const done = client.durable('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    client.close();

    expect((await rejectionOf(done)).code).to.equal('unavailable');
    expect(await outbox.pending()).to.have.length(1);
  });

  it('lists acked among the lifecycle events', () => {
    expect([...LIFECYCLE_EVENTS]).to.include.members(['acked', 'failed']);
  });
});

// Compile-time only: `npm run typecheck` checks the typed durable() signature.
function durableTypeChecks(server: StubServer): void {
  const typed = makeClient(server).typed(defineContract<DurableContract>());
  const result: Promise<{ seq: number }> = typed.durable('docs.submit', { n: 1 }, { key: 'op-1' });
  // @ts-expect-error the payload is checked against the contract
  void typed.durable('docs.submit', { n: 'one' });
  void result;
}
void durableTypeChecks;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/durable-client.test.ts`
Expected: FAIL to compile (the runner type-checks), with errors such as:
- `TS2353: Object literal may only specify known properties, and 'outbox' does not exist in type 'Partial<SocketClientOptions>'`
- the same error for `durable`
- `TS2769: No overload matches this call` for `client.on('acked', …)`
- `TS2554: Expected 1-2 arguments, but got 3` for `durable(…, { key })`

- [ ] **Step 3: Wire the queue into `SocketClient`**

In `packages/http-socket-client/src/client.ts`:

1. Add imports below the existing `./connection.js` import:

   ```ts
   import { DurableQueue, type AckedCommand, type DurableCommandOptions, type DurableOptions, type FailedCommand } from './durable.js';
   import { MemoryOutboxStore, type OutboxStore } from './outbox.js';
   ```

   The `@spinajs/http-socket-common` import stays as it is: `stream()` still uses `SocketException`.

2. In `SocketClientOptions`, add after `io?: IoOptions;`:

   ```ts
   /** Where durable commands wait for their reply, eg. IndexedDbOutboxStore ( `/browser` ); a MemoryOutboxStore when omitted. */
   outbox?: OutboxStore;
   durable?: DurableOptions;
   ```

3. Delete the `FailedCommand` interface from `client.ts`; it lives in `durable.ts` now.

4. In `ClientLifecycleEvents`, replace the `failed` member with:

   ```ts
   /** A durable command was acknowledged; also for commands resumed from the outbox after a reload. In send order. */
   acked: (event: AckedCommand) => void;
   /** A durable command the server refused for good; it is in the outbox's failed list. In send order. */
   failed: (event: FailedCommand) => void;
   ```

5. Replace `LIFECYCLE_EVENTS` with:

   ```ts
   export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set<LifecycleEventName>(['state', 'auth_required', 'incompatible', 'refused', 'acked', 'failed']);
   ```

6. Add the field `private readonly durableQueue: DurableQueue;` after `private readonly commands: CommandDispatcher;`.

7. In the constructor, after `this.commands = new CommandDispatcher(…);`, add:

   ```ts
       this.durableQueue = new DurableQueue({
         connection: this.connection,
         commands: this.commands,
         store: options.outbox ?? new MemoryOutboxStore(),
         clientId: this.clientId,
         reconnect: options.reconnect,
         durable: options.durable,
         onListenerError,
       });
       this.durableQueue.events.on('acked', (event) => this.lifecycle.emit('acked', event));
       this.durableQueue.events.on('failed', (event) => this.lifecycle.emit('failed', event));
   ```

8. Replace the reserved `durable()` method with:

   ```ts
   /** Persisted, ordered and retried until the server answers ( spec §6 ); the server command must be idempotent and ordered: 'client'. */
   public durable<R = unknown>(name: string, payload?: unknown, options?: DurableCommandOptions): Promise<R> {
     return this.durableQueue.submit(name, payload, options) as Promise<R>;
   }
   ```

In `packages/http-socket-client/src/contract.ts`, add `import type { DurableCommandOptions } from './durable.js';` and replace the `durable` member of `TypedSocketClient` with:

```ts
  durable<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: DurableCommandOptions): Promise<CommandResult<C, N>>;
```

Replace `packages/http-socket-client/src/index.ts` with:

```ts
export * from '@spinajs/http-socket-common';
export { SocketClient, LIFECYCLE_EVENTS } from './client.js';
export type { ClientLifecycleEvents, LifecycleEventName, ServerEventListener, SocketClientOptions, Unsubscribe } from './client.js';
export { DEFAULT_TIMEOUT_MS } from './commands.js';
export type { CommandOptions, WhenOffline } from './commands.js';
export { DEFAULT_CONNECT_TIMEOUT_MS } from './connection.js';
export type { AuthPayload, AuthProvider, ConnectionState, IoOptions } from './connection.js';
export type { StreamItem, TypedSocketClient } from './contract.js';
export { DEFAULT_DURABLE } from './durable.js';
export type { AckedCommand, DurableCommandOptions, DurableOptions, FailedCommand } from './durable.js';
export { MemoryOutboxStore } from './outbox.js';
export type { FailedOutboxEntry, OutboxEntry, OutboxInput, OutboxStore } from './outbox.js';
export { DEFAULT_RECONNECT, MAX_SERVER_HINT_MS, ReconnectPolicy } from './reconnect.js';
export type { ReconnectOptions } from './reconnect.js';
```

- [ ] **Step 4: Update the W2 tests that pinned the reserved names**

In `packages/http-socket-client/test/client.test.ts`, replace the test `it('reserves durable() and stream(): both reject with unimplemented', …)` with:

```ts
  it('reserves stream(): it rejects with unimplemented', async () => {
    const client = makeClient(server, { autoConnect: false });

    const iterator = client.stream('docs.snapshot', {})[Symbol.asyncIterator]();
    const streamError = await rejectionOf(iterator.next());

    expect(streamError.code).to.equal('unimplemented');
  });
```

In `packages/http-socket-client/test/index.test.ts`:
- add `'MemoryOutboxStore', 'DEFAULT_DURABLE'` to the list in "exports the client surface and the common protocol"
- add `'DurableQueue'` to the list in "keeps the internals private"

- [ ] **Step 5: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/durable-client.test.ts test/client.test.ts test/index.test.ts test/contract.test.ts && npm run typecheck`
Expected: `0 failing`. `durable-client.test.ts` reports `6 passing`. `client.test.ts` now also checks that a server event named `acked` never reaches the lifecycle listeners. The typecheck prints nothing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npm test`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/client.ts packages/http-socket-client/src/contract.ts packages/http-socket-client/src/index.ts packages/http-socket-client/test/durable-client.test.ts packages/http-socket-client/test/client.test.ts packages/http-socket-client/test/index.test.ts && \
git commit -m "feat(http-socket-client): durable() with an outbox store and the acked and failed lifecycle events"
```

---

### Task 11: `IndexedDbOutboxStore` and the `./browser` entry

**Files:**
- Create: `packages/http-socket-client/src/outbox-indexeddb.ts`
- Create: `packages/http-socket-client/src/browser.ts`
- Modify: `packages/http-socket-client/package.json` (`exports["./browser"]`, devDependency `fake-indexeddb`)
- Test: `packages/http-socket-client/test/indexeddb-outbox.test.ts`

**Interfaces:**
- Consumes: `OutboxStore`, `OutboxEntry`, `FailedOutboxEntry`, `OutboxInput`, `describeOutboxStore` (Task 8); `SocketClient` with `outbox` (Task 10); `serveDurable` (Task 9); `makeClient`.
- Produces:
  - `class IndexedDbOutboxStore implements OutboxStore`, with `constructor(name: string, options?: IndexedDbOutboxOptions)`; `close(): Promise<void>`; database `spinajs-outbox:<name>`, version 1, object stores `pending` (keyPath `seq`, autoIncrement) and `failed` (keyPath `seq`)
  - `interface IndexedDbOutboxOptions { factory?: IDBFactory }`
  - `@spinajs/http-socket-client/browser`: everything the main entry exports, plus `IndexedDbOutboxStore` and `IndexedDbOutboxOptions`

- [ ] **Step 1: Install the test dependency**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm install --save-dev fake-indexeddb@^6.0.0 -w packages/http-socket-client`
Expected: `packages/http-socket-client/package.json` gains `"fake-indexeddb": "^6.…"` under `devDependencies`, and `package-lock.json` changes. Leave the lock file modified and uncommitted.

- [ ] **Step 2: Write the failing tests**

Create `packages/http-socket-client/test/indexeddb-outbox.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import * as browser from '../src/browser.js';
import { IndexedDbOutboxStore } from '../src/outbox-indexeddb.js';
import type { OutboxStore } from '../src/outbox.js';
import { closeAll } from './support/cleanup.js';
import { makeClient } from './support/client.js';
import { serveDurable } from './support/durable.js';
import { describeOutboxStore } from './support/outbox-contract.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

const freshIndexedDb = () => new FakeIDBFactory() as unknown as IDBFactory;

async function drained(store: OutboxStore, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while ((await store.pending()).length > 0) {
    if (Date.now() > end) {
      throw new Error(`outbox not drained within ${timeoutMs} ms`);
    }
    await sleep(20);
  }
}

describeOutboxStore(
  'IndexedDbOutboxStore',
  () => {
    const factory = freshIndexedDb();
    return { create: async () => new IndexedDbOutboxStore('contract', { factory }), reopen: async () => new IndexedDbOutboxStore('contract', { factory }) };
  },
  { reopens: true },
);

describe('IndexedDbOutboxStore', () => {
  it('keeps binary payloads, which a JSON store could not', async () => {
    const store = new IndexedDbOutboxStore('binary', { factory: freshIndexedDb() });
    await store.add({ name: 'blob.put', payload: { bytes: new Uint8Array([1, 2, 3]) } });

    const [entry] = await store.pending();

    expect(Array.from((entry.payload as { bytes: Uint8Array }).bytes)).to.deep.equal([1, 2, 3]);
  });

  it('rejects with a clear error when there is no IndexedDB', async () => {
    const error = await new IndexedDbOutboxStore('none').pending().catch((e: unknown) => e);

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('IndexedDB');
  });

  it('is exported by the ./browser entry beside the main entry', () => {
    expect(browser.IndexedDbOutboxStore).to.equal(IndexedDbOutboxStore);
    expect(browser).to.have.property('SocketClient');
    expect(browser).to.have.property('MemoryOutboxStore');
  });

  describe('a client recreated mid-queue ( spec §7 Durable + reload )', () => {
    let server: StubServer;

    beforeEach(async () => {
      server = new StubServer();
      await server.start();
    });

    afterEach(async () => {
      closeAll();
      await server.stop();
    });

    it('finishes the queue, running each command once and in order', async () => {
      const stub = serveDurable(server, 'docs.submit');
      server.ackFault = { kind: 'delay', ms: 30 };
      const factory = freshIndexedDb();

      const first = makeClient(server, { outbox: new IndexedDbOutboxStore('editor', { factory }), durable: { window: 4 } });
      const calls = Array.from({ length: 20 }, (_, n) => first.durable('docs.submit', { n }).catch(() => 'closed'));
      await until(() => stub.runs.size >= 6);
      // the tab closes: the replies in flight are lost, the rest was never sent
      first.close();
      expect(await Promise.all(calls)).to.include('closed');

      const reloaded = new IndexedDbOutboxStore('editor', { factory });
      expect((await reloaded.pending()).length).to.be.within(1, 19);

      server.ackFault = { kind: 'none' };
      makeClient(server, { outbox: reloaded });
      await drained(reloaded);

      expect(stub.runs.size).to.equal(20);
      expect([...stub.runs.values()].every((runs) => runs === 1)).to.be.true;
      expect(stub.order).to.deep.equal(Array.from({ length: 20 }, (_, n) => `client-1:${n + 1}`));
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/indexeddb-outbox.test.ts`
Expected: FAIL to compile with `TS2307: Cannot find module '../src/browser.js'` and `'../src/outbox-indexeddb.js'`.

- [ ] **Step 4: Implement the store and the entry**

Create `packages/http-socket-client/src/outbox-indexeddb.ts`:

```ts
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
 * ( spec §6 step 5 ). `seq` comes from the object store's key generator, which never reuses a value.
 * Writes resolve once their transaction committed with strict durability.
 */
export class IndexedDbOutboxStore implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(public readonly name: string, private readonly options: IndexedDbOutboxOptions = {}) {}

  public async add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    const record = { name: input.name, payload: input.payload, createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
    const seq = await this.run([PENDING], 'readwrite', (tx) => tx.objectStore(PENDING).add(record));
    return { ...record, seq: seq as number };
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
      const found = pending.get(entry.seq);
      found.onsuccess = () => {
        if (found.result !== undefined) {
          pending.delete(entry.seq);
          tx.objectStore(FAILED).put(entry);
        }
      };
      return undefined;
    });
  }

  public async failed(): Promise<FailedOutboxEntry[]> {
    return (await this.run([FAILED], 'readonly', (tx) => tx.objectStore(FAILED).getAll())) as FailedOutboxEntry[];
  }

  public async clearFailed(seqs?: readonly number[]): Promise<void> {
    await this.run([FAILED], 'readwrite', (tx) => {
      const failed = tx.objectStore(FAILED);
      if (seqs === undefined) {
        failed.clear();
      } else {
        seqs.forEach((seq) => failed.delete(seq));
      }
      return undefined;
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

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
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
      request.onsuccess = () => resolve(request.result);
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

  private async run(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest | undefined): Promise<unknown> {
    const db = await this.open();

    return new Promise((resolve, reject) => {
      // strict: the commit reaches the disk before `complete`, which a durable command relies on
      const tx = db.transaction(stores, mode, { durability: 'strict' });
      const request = work(tx);
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
}
```

Create `packages/http-socket-client/src/browser.ts`:

```ts
export * from './index.js';
export { IndexedDbOutboxStore } from './outbox-indexeddb.js';
export type { IndexedDbOutboxOptions } from './outbox-indexeddb.js';
```

In `packages/http-socket-client/package.json`, replace the `"exports"` object with:

```json
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    },
    "./browser": {
      "types": "./lib/mjs/browser.d.ts",
      "import": "./lib/mjs/browser.js",
      "require": "./lib/cjs/browser.js"
    }
  },
```

- [ ] **Step 5: Run the tests and resolve the subpath from the build**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/indexeddb-outbox.test.ts test/isomorphic.test.ts && npm run typecheck`
Expected: `15 passing` (9 contract, 3 store, 1 reload and 2 isomorphic), then a typecheck with no output.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npm run compile && node --input-type=module -e "const m = await import('@spinajs/http-socket-client/browser'); console.log(typeof m.IndexedDbOutboxStore, typeof m.SocketClient)"`
Expected: `function function`.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/outbox-indexeddb.ts packages/http-socket-client/src/browser.ts packages/http-socket-client/package.json packages/http-socket-client/test/indexeddb-outbox.test.ts && \
git commit -m "feat(http-socket-client): IndexedDbOutboxStore behind the ./browser entry"
```

---

### Task 12: `FileOutboxStore` and the `./node` entry

**Files:**
- Create: `packages/http-socket-client/src/node/file-outbox.ts`
- Create: `packages/http-socket-client/src/node/index.ts`
- Modify: `packages/http-socket-client/package.json` (`exports["./node"]`)
- Modify: `packages/http-socket-client/test/isomorphic.test.ts` (the `src/node/` exception and its guard)
- Test: `packages/http-socket-client/test/file-outbox.test.ts`

**Interfaces:**
- Consumes: `OutboxStore` and the entry types, `describeOutboxStore` (Task 8).
- Produces:
  - `class FileOutboxStore implements OutboxStore`, with `constructor(path: string)`. It keeps one JSON file `{ version: 1, seq, pending, failed }` and rewrites it through `${path}.tmp`, `fsync` and `rename`. Payloads must be JSON.
  - `@spinajs/http-socket-client/node`: everything the main entry exports, plus `FileOutboxStore`
  - The isomorphic rule: `src/node/**` may use Node built-ins and is reachable only through `./node`. No other `src` file imports from it.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket-client/test/file-outbox.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOutboxStore } from '../src/node/file-outbox.js';
import * as node from '../src/node/index.js';
import { describeOutboxStore } from './support/outbox-contract.js';

const root = mkdtempSync(join(tmpdir(), 'spinajs-outbox-'));
let cases = 0;
const nextPath = () => join(root, `case-${++cases}`, 'outbox.json');

describeOutboxStore(
  'FileOutboxStore',
  () => {
    const path = nextPath();
    return { create: async () => new FileOutboxStore(path), reopen: async () => new FileOutboxStore(path) };
  },
  { reopens: true },
);

describe('FileOutboxStore', () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  it('writes the whole queue as one JSON file and leaves no temp file behind', async () => {
    const path = nextPath();
    await new FileOutboxStore(path).add({ name: 'x', payload: { n: 1 } });

    const saved = JSON.parse(readFileSync(path, 'utf8')) as { version: number; seq: number; pending: unknown[]; failed: unknown[] };

    expect(saved).to.include({ version: 1, seq: 1 });
    expect(saved.pending).to.have.length(1);
    expect(saved.failed).to.deep.equal([]);
    expect(existsSync(`${path}.tmp`)).to.be.false;
  });

  it('ignores a temp file a crash left behind', async () => {
    const path = nextPath();
    await new FileOutboxStore(path).add({ name: 'x', payload: 1 });
    writeFileSync(`${path}.tmp`, '{"version":1,"seq":99,"pen');

    expect((await new FileOutboxStore(path).pending()).map((e) => e.seq)).to.deep.equal([1]);
  });

  it('refuses a damaged file instead of starting an empty queue', async () => {
    const path = nextPath();
    await new FileOutboxStore(path).add({ name: 'x', payload: 1 });
    writeFileSync(path, '{"version":1,"seq":1,"pen');

    const error = await new FileOutboxStore(path).pending().catch((e: unknown) => e);

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(path);
  });

  it('applies concurrent changes one after another', async () => {
    const store = new FileOutboxStore(nextPath());

    const entries = await Promise.all(Array.from({ length: 10 }, (_, i) => store.add({ name: 'x', payload: i })));

    expect(entries.map((e) => e.seq)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await store.pending()).map((e) => e.payload)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is exported by the ./node entry beside the main entry', () => {
    expect(node.FileOutboxStore).to.equal(FileOutboxStore);
    expect(node).to.have.property('SocketClient');
  });
});
```

In `packages/http-socket-client/test/isomorphic.test.ts`:

1. Change the path import to `import { join, sep } from 'node:path';`.
2. Add below `NODE_GLOBAL`:

   ```ts
   /** Reachable only through the `./node` subpath. */
   const NODE_ONLY = join(packageDir, 'src', 'node') + sep;
   const NODE_IMPORT = /(^|\/)node\//;
   ```

3. In the test "src imports only relative modules …", replace `const files = sourceFiles(join(packageDir, 'src'));` with:

   ```ts
       const files = sourceFiles(join(packageDir, 'src')).filter((file) => !file.startsWith(NODE_ONLY));
   ```

4. Add a third test:

   ```ts
   it('keeps Node-only code behind the ./node subpath', () => {
     const files = sourceFiles(join(packageDir, 'src')).filter((file) => !file.startsWith(NODE_ONLY));

     for (const file of files) {
       for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
         expect(NODE_IMPORT.test(specifier), `${file} imports ${specifier}`).to.equal(false);
       }
     }
   });
   ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/file-outbox.test.ts`
Expected: FAIL to compile with `TS2307: Cannot find module '../src/node/file-outbox.js'` (and `'../src/node/index.js'`).

- [ ] **Step 3: Implement**

Create `packages/http-socket-client/src/node/file-outbox.ts`:

```ts
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FailedOutboxEntry, OutboxEntry, OutboxInput, OutboxStore } from '../outbox.js';

interface IFileOutbox {
  version: 1;
  /** last seq handed out; kept so a seq is never reused, even after the newest entry was removed */
  seq: number;
  pending: OutboxEntry[];
  failed: FailedOutboxEntry[];
}

const empty = (): IFileOutbox => ({ version: 1, seq: 0, pending: [], failed: [] });

/**
 * The outbox of a Node service, in one JSON file. Every change rewrites the file through a temp file,
 * fsync and rename, so a crash leaves the old queue or the new one, never a torn one. Payloads must be
 * JSON. One process at a time per file.
 */
export class FileOutboxStore implements OutboxStore {
  private cache: IFileOutbox | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(public readonly path: string) {}

  public add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    return this.change((state) => {
      const entry: OutboxEntry<P> = { seq: ++state.seq, name: input.name, payload: input.payload, createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
      state.pending.push(entry);
      return entry;
    });
  }

  public pending(): Promise<OutboxEntry[]> {
    return this.read((state) => state.pending);
  }

  public remove(seq: number): Promise<void> {
    return this.change((state) => {
      state.pending = state.pending.filter((entry) => entry.seq !== seq);
    });
  }

  public fail(entry: FailedOutboxEntry): Promise<void> {
    return this.change((state) => {
      const index = state.pending.findIndex((pending) => pending.seq === entry.seq);
      if (index < 0) {
        return;
      }

      state.pending.splice(index, 1);
      state.failed.push(entry);
      state.failed.sort((a, b) => a.seq - b.seq);
    });
  }

  public failed(): Promise<FailedOutboxEntry[]> {
    return this.read((state) => state.failed);
  }

  public clearFailed(seqs?: readonly number[]): Promise<void> {
    return this.change((state) => {
      state.failed = seqs === undefined ? [] : state.failed.filter((entry) => !seqs.includes(entry.seq));
    });
  }

  private read<T>(pick: (state: IFileOutbox) => T): Promise<T> {
    return this.serial(async () => structuredClone(pick(await this.load())));
  }

  /** The cache changes only after the file did, so a failed write leaves both on the old queue. */
  private change<T>(mutate: (state: IFileOutbox) => T): Promise<T> {
    return this.serial(async () => {
      const draft = structuredClone(await this.load());
      const result = mutate(draft);
      await this.write(draft);
      this.cache = draft;
      return structuredClone(result);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<IFileOutbox> {
    if (this.cache) {
      return this.cache;
    }

    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return (this.cache = empty());
      }
      throw err;
    }

    let state: IFileOutbox;
    try {
      state = JSON.parse(text) as IFileOutbox;
    } catch (err) {
      throw new Error(`outbox file ${this.path} is damaged: ${(err as Error).message}`);
    }

    if (state?.version !== 1 || typeof state.seq !== 'number' || !Array.isArray(state.pending) || !Array.isArray(state.failed)) {
      throw new Error(`outbox file ${this.path} is not a version 1 outbox`);
    }

    return (this.cache = state);
  }

  private async write(state: IFileOutbox): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    const temp = `${this.path}.tmp`;
    const file = await open(temp, 'w');
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temp, this.path);
  }
}
```

Create `packages/http-socket-client/src/node/index.ts`:

```ts
export * from '../index.js';
export { FileOutboxStore } from './file-outbox.js';
```

In `packages/http-socket-client/package.json`, add this after the `"./browser"` entry of `"exports"`:

```json
    "./node": {
      "types": "./lib/mjs/node/index.d.ts",
      "import": "./lib/mjs/node/index.js",
      "require": "./lib/cjs/node/index.js"
    }
```

- [ ] **Step 4: Run the tests and resolve the subpath from the build**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/file-outbox.test.ts test/isomorphic.test.ts && npm run typecheck`
Expected: `17 passing` (9 contract, 5 file and 3 isomorphic), then a typecheck with no output.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npm run compile && node --input-type=module -e "const m = await import('@spinajs/http-socket-client/node'); console.log(typeof m.FileOutboxStore, typeof m.SocketClient)"`
Expected: `function function`.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npm test`
Expected: `0 failing`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/node/file-outbox.ts packages/http-socket-client/src/node/index.ts packages/http-socket-client/package.json packages/http-socket-client/test/file-outbox.test.ts packages/http-socket-client/test/isomorphic.test.ts && \
git commit -m "feat(http-socket-client): FileOutboxStore behind the ./node entry"
```

---

### Task 13: End to end: the §7 Durable, Shutdown and Rooms rows with the real client

**Files:**
- Modify: `packages/http-socket/package.json` (devDependency `@spinajs/http-socket-client`)
- Test: `packages/http-socket/test/durable-e2e.test.ts`

**Interfaces:**
- Consumes:
  - server: `SocketServer.shutdown` (Task 6), `IdempotencyStage` + the fence (Tasks 4–5), `SocketConnection.recovered` (Task 7)
  - fault kit: `killConnections`, `ackFaults`, `restart` (Task 2)
  - client: `SocketClient.durable` (Task 10), from the built `@spinajs/http-socket-client` (`lib/mjs`)
- Produces: the proof of spec §7's Durable, Ordering, Shutdown and Rooms rows. No API.

- [ ] **Step 1: Add the client as a devDependency and build what the test imports**

In `packages/http-socket/package.json`, add to `"devDependencies"` (keep the keys sorted):

```json
    "@spinajs/http-socket-client": "3.0.0-alpha.0",
```

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && npm install && cd packages/http-socket-common && npm run compile && cd ../http-socket-client && npm run compile`
Expected: `npm install` links the workspace package; `package-lock.json` changes, and you leave it uncommitted. Both compiles print nothing.

- [ ] **Step 2: Write the tests**

Create `packages/http-socket/test/durable-e2e.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { SocketClient, type SocketClientOptions } from '@spinajs/http-socket-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, Payload, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { SocketHub } from '../src/hub.js';
import { ITestServer, delay, startServer, waitFor } from './harness.js';
import { ackFaults, killConnections, restart } from './faults.js';

export const e2eRuns = new Map<number, number>();
export const e2eOrder: number[] = [];
export const e2eHooks: boolean[] = [];

@SocketController('e2e')
export class DurableE2eSocket extends BaseSocketController {
  @Command('apply', { idempotent: true, ordered: 'client' })
  public async apply(@Payload() p: { n: number; ms: number }) {
    await delay(p.ms);
    e2eRuns.set(p.n, (e2eRuns.get(p.n) ?? 0) + 1);
    e2eOrder.push(p.n);
    return p.n;
  }

  @Command('slow')
  public async slow(@Payload() p: { ms: number }) {
    await delay(p.ms);
    return 'slow done';
  }

  @Command('ping')
  public async ping() {
    return 'pong';
  }

  @Command('join')
  public async join(@Connection() conn: SocketConnection) {
    conn.join('e2e-room');
    return true;
  }

  @OnConnect()
  public async seen(@Connection() conn: SocketConnection) {
    if (conn.clientId === 'e2e-rooms') {
      e2eHooks.push(conn.recovered);
    }
  }
}

/** Seeded, so a failing run can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (count: number) => Array.from({ length: count }, (_, n) => n);

// The test is about drops, not limits: 1 000 serial commands would otherwise spend most of their time rate-limited.
const UNLIMITED = { http: { socket: { rate: { perSecond: 5_000, burst: 1_000 }, maxInFlightEventsPerConnection: 1_000 } } };

describe('W3 end to end: the real client against the real server', function () {
  this.timeout(120_000);

  let t: ITestServer;
  let clients: SocketClient[] = [];

  const client = (clientId: string, extra: Partial<SocketClientOptions> = {}) => {
    const c = new SocketClient({ url: t.url, path: t.path, clientId, reconnect: { minMs: 10, maxMs: 50, jitter: 0 }, io: { transports: ['websocket'] }, ...extra });
    clients.push(c);
    return c;
  };

  const online = (c: SocketClient) =>
    new Promise<void>((resolve) => {
      if (c.state === 'online') {
        resolve();
        return;
      }
      const off = c.on('state', (state) => {
        if (state === 'online') {
          off();
          resolve();
        }
      });
    });

  beforeEach(() => {
    e2eRuns.clear();
    e2eOrder.length = 0;
    e2eHooks.length = 0;
  });

  afterEach(async () => {
    ackFaults.reset();
    clients.forEach((c) => c.close());
    clients = [];
    await t.close();
  });

  it('runs 1 000 durable commands exactly once and in order while the connection is killed 100 times', async () => {
    t = await startServer(UNLIMITED);
    const c = client('e2e-durable');
    await online(c);
    const resolved: number[] = [];
    let finished = false;
    const all = Promise.all(range(1000).map((n) => c.durable<number>('e2e.apply', { n, ms: 5 }).then((v) => void resolved.push(v)))).finally(() => {
      finished = true;
    });

    const random = mulberry32(7);
    let kills = 0;
    while (kills < 100 && !finished) {
      await online(c);
      await delay(5 + Math.floor(random() * 20));
      if (random() < 0.3) {
        // the worst case: the handler ran and its reply is lost
        ackFaults.drop = 1;
        await waitFor(() => ackFaults.drop === 0 || finished, 5_000);
      } else {
        killConnections(t);
      }
      kills++;
    }
    await all;

    expect(kills).to.equal(100);
    expect(resolved).to.deep.equal(range(1000));
    expect(e2eOrder).to.deep.equal(range(1000));
    expect([...e2eRuns.values()].every((runs) => runs === 1)).to.be.true;
  });

  it('drains on shutdown: running commands finish, new ones get unavailable, and the queue drains on the restarted server', async () => {
    const cfg = { http: { socket: { drainMs: 3_000, shutdownRetryAfterMs: 100 } } };
    t = await startServer(cfg);
    const c = client('e2e-shutdown');
    await online(c);
    const resolved: number[] = [];
    const all = Promise.all(range(50).map((n) => c.durable<number>('e2e.apply', { n, ms: 20 }).then((v) => void resolved.push(v))));
    await waitFor(() => e2eRuns.size >= 10, 10_000);

    const slow = c.command<string>('e2e.slow', { ms: 500 });
    await delay(20);
    const notice = new Promise((resolve) => c.once('sys.shutdown', resolve));
    const restarted = restart(t, cfg);
    await notice;
    const refused = await c.command('e2e.ping').then(
      () => null,
      (error: { code: string }) => error,
    );

    expect(await slow).to.equal('slow done');
    expect(refused).to.include({ code: 'unavailable' });

    t = await restarted;
    await all;

    expect(resolved).to.deep.equal(range(50));
    expect(e2eRuns.size).to.equal(50);
    expect([...e2eRuns.values()].every((runs) => runs === 1)).to.be.true;
  });

  it('replays room events missed during a 5 s drop, and the connect hooks see the recovery', async () => {
    t = await startServer();
    const c = client('e2e-rooms', { reconnect: { minMs: 5_000, maxMs: 5_000, jitter: 0 } });
    await online(c);
    await c.command('e2e.join');
    const news: unknown[] = [];
    c.on('e2e.news', (payload) => news.push(payload));
    const hub = DI.resolve(SocketHub);

    // the client asks for recovery only once it holds the offset of a received push; acks carry none
    hub.to('e2e-room').emit('e2e.news', { n: 0 });
    await waitFor(() => news.length === 1);

    killConnections(t);
    await delay(200);
    expect(c.state).to.equal('offline');
    hub.to('e2e-room').emit('e2e.news', { n: 1 });

    await waitFor(() => news.length === 2, 10_000);
    expect(news).to.deep.equal([{ n: 0 }, { n: 1 }]);
    expect(e2eHooks).to.deep.equal([false, true]);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/durable-e2e.test.ts`
Expected: `3 passing`. The first test takes roughly 10–40 s. If it fails, work out which property failed:
- a duplicate in `e2eOrder`, or a run count of 2, means exactly-once broke;
- an out-of-order `resolved` means the client's in-order settlement broke;
- an out-of-order `e2eOrder` means the fence broke.

Use superpowers:systematic-debugging, and never loosen the assertions.

There is nothing to watch fail first here. These rows exercise Tasks 4–10 together, and each of those tasks proved its own part RED before GREEN. To check that this test can fail, temporarily replace `await this.assertAfter(ctx);` in `src/stages/ordering.ts` with nothing. The first test must then fail on `e2eOrder` or the run counts. Restore the line before you commit.

- [ ] **Step 4: Run every suite**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts && cd ../http-socket-client && npm test && npm run typecheck && cd ../http-socket && npm test`
Expected: `0 failing` in all three packages; the typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/package.json packages/http-socket/test/durable-e2e.test.ts && \
git commit -m "test(http-socket): end to end durable, shutdown and recovery rows with the real client"
```

---

### Task 14: Release notes and the full build

**Files:**
- Modify: `packages/http-socket/RELEASE_NOTES.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the W3 notes X1 merges into the root `RELEASE_NOTES.md`.

- [ ] **Step 1: Replace the two W1 behaviour notes W3 changed**

In `packages/http-socket/RELEASE_NOTES.md`, under `## Behaviour notes`, replace the bullet that starts `- **Shutdown.**` with:

```markdown
- **Shutdown.** `dispose()` runs `SocketServer.shutdown()`, which the `http.server.closing` DI event also starts. The steps:
  1. Refuse new handshakes, recovered sockets and new commands with a retryable `unavailable` carrying `retryAfterMs = http.socket.shutdownRetryAfterMs`.
  2. Send `sys.shutdown { retryAfterMs }` to every local connection.
  3. Let running commands finish for up to `drainMs`.
  4. Answer the rest with `unavailable`, and wait for those replies to be written.
  5. Close the sockets, and wait up to `drainMs` for the disconnect hooks while the hub can still push. Then close.

  Set `http.shutdownTimeout` to at least `http.socket.drainMs`, or the http server destroys the sockets mid-drain.
```

and replace the bullet that starts `- **Connection state recovery.**` with:

```markdown
- **Connection state recovery.** A recovered connection keeps its socket id, and `SocketConnection.recovered` is `true`.
  - Its disconnect hooks ran at the drop. Its connect hooks run again on recovery and can read `conn.recovered`, for example to skip re-joining rooms, which recovery restores.
  - A recovered connection whose principal has a source is re-checked with that source before its hooks and commands run, whatever `auth.revalidateMs` says. An `'invalid'` answer closes it with `sys.disconnect { reason: 'unauthenticated' }`. A `'valid'` answer that carries a principal replaces the restored one; that is how a session restored through a serializing adapter gets its `Principal.identity` back. A source that answers plain `true` keeps the flattened one.
  - A stored session is restored, with its missed pushes, only while its principal is unexpired, not due for revalidation, and not revoked (closed by the principal guard). Otherwise the client gets a full handshake and a new id, without the missed pushes.
  - The restore filter wraps socket.io 4.8 internals (`adapter.restoreSession`, `Namespace._initAdapter`). `test/recovery.test.ts` must pass before any socket.io upgrade.
```

- [ ] **Step 2: Replace "Notes for W3" with the W3 notes**

Replace the whole `## Notes for W3 (resilience)` section (its heading and its three bullets) with:

```markdown
## W3 resilience — breaking changes

- **`isCommandRequest` is stricter.** `idempotencyKey` and the new `after` must be 1–256 printable ASCII characters (`isKey`, `MAX_KEY_LENGTH`). A frame that breaks this is refused as a malformed command (`invalid_argument`).
- **An `idempotencyKey` on a command that is not `idempotent`** is refused with `failed_precondition`. An `after` without an `idempotencyKey` is refused with `invalid_argument`, and an `after` on a command that is not `ordered: 'client'` with `failed_precondition`.
- **`dispose()` drains**, up to `drainMs` (5 s by default) plus up to `drainMs` for the disconnect hooks. Tests that close servers with handlers still running can set `http.socket.drainMs: 0`.
- **`@spinajs/http-socket-client`: `durable()` is implemented**, and the lifecycle event `acked` joins `failed`. A server event named `acked` no longer reaches `client.on()`.

## W3 resilience — new

### Idempotent commands (pipeline step 5, `IdempotencyStage`, Order 500)

- `@Command(name, { idempotent: true })` plus a request `idempotencyKey`: a completed key replays its stored reply, and a running key is joined. The handler never runs twice for one `(principalKey, clientId, idempotencyKey)`.
- A result and a non-retryable error are stored. A replayed error keeps its `errorId`.
- A retryable error, the call's own abort (deadline, cancel, disconnect, shutdown while queued) and a stream result release the key.
- A key stays running until its handler settles, even after the client got an abort reply. This holds even for a handler the ordering stage cut loose after `ordering.abortGraceMs`.
- `IdempotencyStore` is pluggable through `http.socket.idempotency.service` (a class name; the whole `http.socket.idempotency` object is its first constructor argument). The default `MemoryIdempotencyStore` keeps up to `maxEntries` (100 000) completed keys for `ttlMs` (10 min), least recently used first out.
- A store shared by several instances must make `claim` atomic. While another instance runs a key, this one answers a retryable `unavailable` with `retryAfterMs: 1000`.

### Durable commands

- **Wire.** `CommandRequest.after` names the idempotency key of the durable command sent before. The ordering stage runs the command only once that one has completed (a result or a final error), and otherwise answers a retryable `unavailable`. The outcome of an ordered command is stored before its queue place is released.
- **Client.** `client.durable(name, payload, { key? })` writes the command to the `outbox` store before it sends it, with `idempotencyKey = clientId:<random nonce persisted with the entry>` (see `packages/http-socket/RELEASE_NOTES.md`, "W3 resilience (spec amendments)") or the app's key. It then:
  - sends up to `durable.window` (16) commands at once, each `after` the previous unacknowledged one, with no deadline;
  - resends everything unacknowledged after any drop, and resends a command unanswered after `durable.ackTimeoutMs` (60 s);
  - retries retryable errors and `unauthenticated` with the reconnect backoff, honouring `retryAfterMs`;
  - moves a command refused for good to the store's `failed` list and emits `failed`.

  Callers and the `acked` / `failed` listeners hear about commands in send order. `close()` rejects waiting callers with a non-retryable `unavailable`; the entries stay in the store.
- **Stores.**
  - `MemoryOutboxStore` (the default)
  - `IndexedDbOutboxStore(name, { factory? })` from `@spinajs/http-socket-client/browser`
  - `FileOutboxStore(path)` from `@spinajs/http-socket-client/node`
  - Every store passes one contract suite: a durable `add` before the send, a `seq` that is never reused, a `failed` list kept until `clearFailed`.

### Graceful shutdown

`SocketServer.shutdown()`; see the Shutdown behaviour note. New config: `http.socket.shutdownRetryAfterMs` (default `5_000`).

### Recovery

`SocketConnection.recovered`, and the principal re-check of recovered connections; see the Connection state recovery behaviour note.

## W3 resilience — startup checks

`SocketServer` also refuses to start with a `RangeError` when:

- `idempotency.service` is not a non-empty string, when `idempotency.ttlMs` is not within (0, 2^31−1], or when `idempotency.maxEntries` is not an integer above 0;
- `drainMs` is not within [0, 2^31−1], or when `shutdownRetryAfterMs` is not a finite number above 0.

`SocketClient` throws a `RangeError` for a `durable.window` that is not an integer of at least 1, and for an invalid `durable.ackTimeoutMs`. `durable()` rejects with a `RangeError` for a `key` that `isKey` refuses.

## W3 resilience — known limits

- `MemoryIdempotencyStore` gives exactly-once across disconnects and across a graceful restart, because the drain flushes every reply. It does not after a crash, or after an ack lost right before a restart: the resend runs again. Use a persistent store, or deduplicate in the handler (the editor deduplicates by `opId` in its op log).
- A completed key is forgotten after `ttlMs`. An unacknowledged entry resent after a longer offline period runs again.
- `ordered: 'client'` queues and the `after` fence are per instance. Several instances need sticky sessions.
```

- [ ] **Step 3: Build everything**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-common/tsconfig.mjs.json packages/http-socket-client/tsconfig.mjs.json packages/http-socket/tsconfig.mjs.json && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-common/tsconfig.cjs.json packages/http-socket-client/tsconfig.cjs.json packages/http-socket/tsconfig.cjs.json`
Expected: no output (both module formats build).

- [ ] **Step 4: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/RELEASE_NOTES.md && \
git commit -m "docs(http-socket): W3 resilience release notes"
```

---

## Spec coverage (W3 scope)

| Spec item | Task |
|---|---|
| §5.2 step 5: replay a completed key, join a running one, never run twice | 3, 4 |
| §5.5 `IdempotencyStore`: pluggable, in-memory LRU + TTL 10 min | 3 |
| §5.5 graceful shutdown, steps 1–5, `drainMs` | 6 |
| §5.5 recovery (2 min, configured in W1) + W1 deferred `recovered` flag and flattened identity | 7 |
| §5.6 `idempotency { service, ttlMs }`, `drainMs` | 3, 6 |
| §6 durable steps 1–5: persist first, `clientId:<random nonce persisted with the entry>` (spec amendment, RELEASE_NOTES), window 16, resend after drops, retry/backoff, `failed` list + event | 1, 5, 8, 9, 10 |
| §6 stores: memory, IndexedDB (`/browser`, `fake-indexeddb`), file (Node) | 8, 11, 12 |
| §6 `sys.shutdown` waits `retryAfterMs` (W2, unchanged); refused handshake carries the hint | 6 |
| §7 fault kit: kill the engine connection, delay or drop acks, restart on the same port | 2 |
| §7 Idempotency row | 4 |
| §7 Ordering row (across a reconnect) | 5, 13 |
| §7 Durable row (1 000 commands, 100 kills, exactly once, in order) | 13 |
| §7 Durable + reload row | 11 |
| §7 Shutdown row | 6, 13 |
| §7 Rooms row (recovery replays a 5 s drop) | 13 |
| W1 deferred: dropped `unavailable` replies, unawaited disconnect hooks after `Hub.detach` | 6 |
| W1 deferred: idempotency keyed `(principalKey, clientId, key)`, independent of the running map; abort releases the request id | 4 (D1, D3) |
| W2 seams: `outbox` option, `durable()`, `failed` lifecycle, `./browser` | 10, 11 |

Not in W3: stream replies and their idempotency (W4: an idempotent command returning a stream releases its key), persistent `IdempotencyStore`s (ORM, Redis), and multi-instance ordering.
