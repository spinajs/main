# W4 Streams, session source, docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream replies with credit-based flow control, end to end (protocol, server, client); a runnable example app with an end-to-end suite; the package READMEs; and, behind its gate, the `@spinajs/authn-http/socket` session-cookie principal source.

**Architecture:** A command handler that returns an async iterable is answered with `{ ok: true, stream: true }`. A `ServerStream` then pulls one item from the generator per unit of client credit and sends it as a `chunk` frame, then `end` or `fail`. The stream keeps its request id in the dispatcher's running map until it ends, so the existing cancel, disconnect and shutdown paths reach it unchanged. On the client, a `StreamDispatcher` (a new consumer of W2's `Connection` seams) gives each `stream()` call a lazy `ClientStream` async iterator: it sends the window as `credits` on the request, buffers at most that many chunks, grants more as the consumer reads, and sends `cancel` on `break`. Resume after a drop stays an app concern (`fromChunk` in the payload), shown by the example app. The session source is a `SocketPrincipalSource` in `@spinajs/authn-http/socket`.

**Tech Stack:** TypeScript 7 (ESM, `node16` resolution, dual mjs/cjs build), socket.io 4.8 / socket.io-client 4.8, `@spinajs/di`, `@spinajs/configuration`, `@spinajs/log`, `@spinajs/authz` / `@spinajs/authn/contracts` (contracts only), mocha + chai + chai-as-promised + sinon through `ts-mocha`.

**Spec:** `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md`: §4 (wire protocol: `CommandStreamReply`, `Chunk`, `chunk | end | fail`, `credit | cancel`), §5.1 (`async *snapshot` handler), §6 (client streams), §7 (Streams row), §8 (W4 row). Consumer: `coderush/engine/docs/superpowers/specs/2026-10-02-editor-server-sync-mcp-design.md` §6.1–§6.2 (`doc.snapshot` stream with credits and `fromChunk` resume, binary `blob.get` / `blob.put`).

---

## Open questions (owner) — the plan uses the recommended default

- **Q1. Order of the session source.** The W1 brief (G6) says order 100, "the slot of authn-http's session resolver". In http, though, `AuthnMiddleware` restores the session first, and "an active session ignores bearer credentials", so the session wins. On sockets, sources run in ascending order and the first non-null wins, so order 100 would let a bearer token (`AuthnCredentialSource`, order 50) win instead. **Default: order 40**, which gives http parity. A pending session returns null, so a bearer token is still tried, as in http.
- **Q2. What do `deadline` and `@Command({ timeoutMs })` bound for a stream?** **Default: the time to the stream reply only.** After that, the server fails a stream that gets no credit for `http.socket.streams.stallTimeoutMs` (default 60 s) with `deadline_exceeded`. The client's `timeoutMs` bounds each wait for the next frame. A total stream deadline would cut a large snapshot on a slow link.
- **Q3. Resume after a drop.** **Default: app-level**, as in the editor spec (`fromChunk` in the payload). The client stream delivers the chunks it already received and then rejects with a retryable `unavailable`. The example app ships a 30-line `loadSnapshot` that resumes. The library does not resume by itself, because it cannot know that a stream is resumable or how.
- **Q4. A client that grants more credit than `streams.maxCredits` (default 64).** **Default: fail the stream with `invalid_argument`** (`details: { limit }`), both at the request and on a later grant. Silent clamping would desynchronise the client's window accounting. A correct client never trips this, because its window caps what it has outstanding.
- **Q5. `@User()` argument (spec §5.1).** W1's release notes rule "There is no `@User()` parameter decorator. Use `@Connection() conn` and read `conn.user`", and the Q1 answer of the W1 brief says `@User()` is unnecessary. **Default: not built.**
- **Q6. `stream()` on a command that answers a plain result, and `command()` on a stream command.** **Default: both fail with `failed_precondition`.** The server refuses a stream handler called without `credits` before its generator starts, and the client rejects a plain result in `stream()`.

## Gate status (checked 2026-10-03)

| Part | Gate | Status |
|---|---|---|
| Tasks 1–8 | W1 + W2 merged | **Met**: `feat/websocket-layer` holds W1, W2 and common, merged with `feat/authz-v3` (2cbe05da0). |
| Task 9 (session source, gated) | authz-v3 lanes **N2** and **N8a** merged into `feat/authz-v3`; owner answer to Q1 of the W1 brief | **Not met.** The Q1 answer is recorded (`authn-http/socket` subpath). Branch `authz/N2-session` (d090fb508, worktree `Spinajs/authz-v3-N2`) is **not** an ancestor of `feat/authz-v3` (76807598f). **N8a has no branch or worktree.** On `feat/authz-v3`, `packages/authn-session/src` holds only `contracts.ts`, and `authn-http`'s `SessionPrincipalResolver`, `AuthnMiddleware` and `ClientIp` are `notImplemented` stubs. |

## Global Constraints

- **Repo / branch.** Worktree `C:\Users\grzch\SourceCodes\Spinajs\websocket-layer`, branch `feat/websocket-layer`. Never touch another Spinajs checkout or worktree. (A separate worktree for W4 is described under "Parallelism with W3"; in that mode replace the path and branch in every command.)
- **Shared worktree.** Other agents (W3, G1 follow-ups) may work in this worktree. Stage only the exact paths a step lists (`git add <paths>`, never `git add -A` / `git add .`). Never `git stash`, `git reset`, `git checkout -- …` or `git clean`. Every commit checks the branch in the same command: `test "$(git branch --show-current)" = feat/websocket-layer && git add … && git commit …`.
- **Lock file and installs.** Never commit `package-lock.json`. Do not run `npm install`: the root `node_modules/@spinajs/*` already links every workspace package this plan uses (`http-socket`, `http-socket-client`, `http-socket-common`, `authn-http`, `authn-session`). The new example package resolves through those links.
- **Release notes.** `packages/http-socket/RELEASE_NOTES.md` is the socket layer's notes file (X1 merges it into the root notes). Never edit the root `RELEASE_NOTES.md`.
- **Versioning** (authz-v3 convention on this branch). Existing packages keep their versions: `@spinajs/http-socket` `2.0.548`, `@spinajs/http-socket-client` and `@spinajs/http-socket-common` `3.0.0-alpha.0`. A new package starts at `3.0.0-alpha.0`. Internal deps are pinned exactly (`2.0.548` for the 2.x packages, `3.0.0-alpha.0` for authz/authn and the socket packages).
- **Package rules.** `@spinajs/http-socket-common` stays dependency-free and isomorphic: no `node:*` imports, no `Buffer`. `@spinajs/http-socket-client`'s runtime dependencies stay `socket.io-client` and `@spinajs/http-socket-common` only, and its `src/` uses no Node built-ins or Node globals (`test/isomorphic.test.ts` enforces this). `@spinajs/http-socket` imports `@spinajs/authz` and `@spinajs/authn/contracts` only, never `authn-http` or `authz-http`. An `authn*` package must not depend on `users` or `authz*` (authz-v3 plan §1 rule 10). Task 9 therefore imports `Principal` from `@spinajs/authn/contracts`.
- **Wire names (verbatim, spec §4).** Server→client `chunk` | `end` | `fail`; client→server `credit` | `cancel`. Always use `WIRE_EVENTS.*`, never a string literal, in `src/`. Frames:
  - `CommandStreamReply { id, ok: true, stream: true }`
  - `Chunk { id, seq, data }`, `StreamEnd { id, seq }` (`seq` = the number of chunks sent)
  - `StreamFail { id, error: SocketError }`
  - `StreamCredit { id, credits }`, `CancelFrame { id }`
  - This plan adds one optional request field: `CommandRequest.credits` (the initial window).
- **Spec §6, verbatim:** "Credit-based flow control. The client grants credits (default 8 chunks) and grants more as the consumer reads. Breaking out of the `for await` sends `cancel`, and the server generator's `finally` runs."
- **Spec §7 Streams row, verbatim:** "A slow consumer never has more chunks in flight than its credit; `cancel` runs the generator's `finally`".
- **Stream behaviour this plan fixes:**
  - The server pulls the next item only while it holds credit. Finding the end therefore also takes one unit of credit, and the client grants as it reads.
  - Chunks are numbered from 0. `undefined` items are sent as `null`.
  - The client keeps `granted − consumed ≤ credits` at all times. It grants in batches of at least `max(1, floor(credits / 2))`.
- **Error codes:** the 13 of spec §4. Stream-specific answers:

  | Situation | Code | Retryable |
  |---|---|---|
  | stream command called without credits | `failed_precondition` | no |
  | credit above `maxCredits` | `invalid_argument` | no |
  | more than `streams.maxPerConnection` open | `resource_exhausted` | yes, `retryAfterMs` 100 |
  | no credit for `stallTimeoutMs` | `deadline_exceeded` | yes |
  | cancel | `cancelled` | no |
  | disconnect / shutdown | `unavailable` | yes |
  | unencodable chunk | `internal` | no |
  | client: frames out of order / over credit / malformed reply | `internal` | no |
  | client: no reply, or no frame in `timeoutMs` | `deadline_exceeded` | yes |
  | client: connection dropped | `unavailable` | yes |
  | client: plain result in `stream()` | `failed_precondition` | no |
- **Config `http.socket.streams` defaults:** `{ maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 60_000 }`.
- **Client constant:** `DEFAULT_STREAM_CREDITS = 8`.
- **Builds.** Packages consume each other through built `lib/`. After changing `src/` of a package, rebuild it before running a dependent package's tests:
  - common: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-common/tsconfig.mjs.json packages/http-socket-common/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
  - server: same with `packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json`
  - client: same with `packages/http-socket-client/tsconfig.mjs.json packages/http-socket-client/tsconfig.cjs.json`
- **Tests.** mocha + chai (+ chai-as-promised, sinon) via `ts-mocha -p tsconfig.json`, run from inside the package: `npx ts-mocha -p tsconfig.json test/<file>.test.ts`.
  - Server tests run a real server on a random port with a raw `socket.io-client` (`test/harness.ts`). **Do not edit `packages/http-socket/test/harness.ts`** (G1 and W3 own it); stream helpers go in `test/stream-client.ts`.
  - Client tests use W2's stub server.
  - DI registry keys are class names, so every test-only class gets a suite-unique, exported name. The socket controller prefixes used here are `strm`, `strmobs`, `sess`, `notes` and `blob`.
- **Code style:** English identifiers and comments; comment only a non-obvious "why". Prettier config: `printWidth 1500`, single quotes, trailing commas. ESM imports with `.js` suffixes.
- **Commits:** `feat(http-socket-common): …`, `feat(http-socket): …`, `feat(http-socket-client): …`, `feat(http-socket-example): …`, `docs(…)`, `feat(authn-http): …`.

## File map

`packages/http-socket-common/`

| File | Change |
|---|---|
| `src/protocol.ts` | `CommandRequest.credits`, guards `isChunk`, `isStreamEnd`, `isStreamFail`, `isStreamCredit` (Task 1) |
| `test/common.test.ts` | Stream frame guard tests (Task 1) |
| `README.md` | New (Task 8) |

`packages/http-socket/`

| File | Change |
|---|---|
| `src/stream.ts` | New: `ServerStream`, credit-gated pump (Task 2) |
| `src/interfaces.ts` | `ISocketStreamsConfig`, `ISocketServerConfig.streams`, `IConnectionRuntime.streams` (Task 3) |
| `src/config/http-socket.ts` | `streams` defaults (Task 3) |
| `src/limits.ts` | `assertStreamsConfig` (Task 3) |
| `src/context.ts` | `SocketCommandContext.stream` (Task 3) |
| `src/dispatcher.ts` | Credit listener, stream reply in `toReply`, `openStream`, `runStream`, running-map lifetime (Task 3); stream observation (Task 4) |
| `src/metrics.ts` | `socket_streams_total`, `observeStream` (Task 4) |
| `test/stream.test.ts` | `ServerStream` unit tests (Task 2) |
| `test/stream-client.ts` | Raw stream test helper (Task 3) |
| `test/streams.test.ts`, `test/stream-config.test.ts` | End-to-end stream tests, config (Task 3) |
| `test/stream-observability.test.ts` | Metrics and debug line (Task 4) |
| `test/pipeline.test.ts` | The W1 "unimplemented until W4" test becomes `failed_precondition` (Task 3) |
| `test/exports.test.ts` | Snapshot additions (Tasks 1, 4) |
| `RELEASE_NOTES.md` | Stream replies section (Task 4); session source line (Task 9) |
| `README.md` | Rewritten (Task 8); session section (Task 9) |

`packages/http-socket-client/`

| File | Change |
|---|---|
| `src/streams.ts` | New: `StreamDispatcher`, `ClientStream`, `StreamOptions`, `DEFAULT_STREAM_CREDITS` (Task 5) |
| `src/client.ts`, `src/contract.ts`, `src/index.ts` | `stream()` wired, typed, exported (Task 6) |
| `test/support/stub-server.ts` | `RawReply` also receives the socket (Task 5, two lines) |
| `test/support/stream-stub.ts`, `test/support/streams.ts` | New stub stream server and helpers (Task 5) |
| `test/streams.test.ts`, `test/stream-lifecycle.test.ts` | New (Task 5) |
| `test/client-stream.test.ts` | New (Task 6) |
| `test/index.test.ts` | Exports (Task 6) |
| `README.md` | New (Task 8) |

`packages/http-socket-example/` (new, private; Task 7): `package.json`, `tsconfig*.json`, `.mocharc.json`, `.gitignore`, `README.md`, `src/{contract,store,auth,notes.socket,server,client,main}.ts`, `test/example.test.ts`. Root: `tsconfig.build.json` (one line).

`packages/authn-http/` (gated Task 9): `src/socket/{index,session-source}.ts`, `test/socket-session.test.ts`, `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`.

## Parallelism with W3 (resilience) and G1

W3 (`docs/superpowers/plans/2026-10-03-ws-w3-resilience.md`) adds the idempotency stage (500), durable commands and outbox stores, recovery settings, the fault kit and the shutdown drain. G1 is the gated authz-host task of W1.

**Files both plans touch** (expect textual merges in separate hunks, never in the same lines):

| File | W4 hunk | Likely W3 hunk |
|---|---|---|
| `http-socket/src/dispatcher.ts` | imports, `sockets` field, `attach` (credit listener, `streams: 0`), `execute` finally, `onCommand` tail, new `onCredit`, `toReply`/`openStream`/`runStream`/`streamEnded` | a public running counter for the drain, `abortAll` use |
| `http-socket/src/interfaces.ts` | `ISocketStreamsConfig`, `streams` keys | `IdempotencyStore`, idempotency/shutdown config |
| `http-socket/src/config/http-socket.ts` | `streams` block after `hooks` | idempotency store name, drain/recovery keys |
| `http-socket/src/server.ts` | none | `dispose()` drain |
| `http-socket/src/index.ts` | none (stream.ts stays internal) | store exports |
| `http-socket/test/exports.test.ts` | 7 names | W3's names |
| `http-socket/RELEASE_NOTES.md` | "Stream replies (W4)" section, config/startup bullets | its own sections |
| `http-socket/test/harness.ts` | **none** | restart-on-same-port hook |
| `http-socket-client/src/client.ts` | `streams` field, constructor line, `stream()` body | `outbox` option, `durable()` body, `failed` |
| `http-socket-client/src/index.ts`, `src/contract.ts`, `test/index.test.ts` | stream exports and types | durable exports and types, `./browser` |
| `http-socket-client/test/support/stub-server.ts` | `RawReply` gets `socket` | fault kit additions |
| `http-socket-common/src/protocol.ts` | `credits`, 4 guards | possibly none |

**Ordering and coordination rules:**

- **W4 Tasks 1, 2, 5 and 7** only create files or touch lines no W3 task touches. They can run in parallel with W3 in this worktree.
  - Task 1's exports-snapshot edit is two inserted lines.
  - Task 5's stub edit is two lines.
  - Task 7 depends on Tasks 1–6.
- **W4 Tasks 3, 4, 6 and 8** edit files W3 also edits. Run them either in a separate worktree (`git worktree add ../ws-w4 -b feat/ws-w4 feat/websocket-layer`, then `npm install` and `node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json` there before Task 1; merge `feat/ws-w4` back when done), or in this worktree only while no W3 task is editing the same file.
- **Idempotent streams (W3).** W3's idempotency stage must not store an async iterable result. Recommended: pass it through unrecorded, or refuse `idempotent: true` with a stream result (`failed_precondition`). A stored generator cannot be replayed.
- **Shutdown drain (W3).** An open stream stays in `IConnectionRuntime.running` until its `end`/`fail` frame. A drain that waits while `running` is non-empty therefore waits for streams too, up to `drainMs`. `abortAll(unavailable)` then fails them with `unavailable`, and their generators' `finally` runs. W3 needs no stream-specific code. Its running counter should count `running.size`.
- **README (W3).** Task 8 creates the READMEs with the W1/W2/W4 features. W3 adds its own sections ("Durable commands", "Graceful shutdown") to `packages/http-socket/README.md` and `packages/http-socket-client/README.md` after Task 8 lands. If W3 lands first, Task 8 still writes the files as given, and W3's executor adds its sections afterwards.

---

### Task 1: Stream frames in the shared protocol

**Files:**
- Modify: `packages/http-socket-common/src/protocol.ts` (import line 1, `CommandRequest`, `isCommandRequest`, guards at the end)
- Test: `packages/http-socket-common/test/common.test.ts` (new `describe` before `describe('contracts'`)
- Modify: `packages/http-socket/test/exports.test.ts` (the server re-exports common, so its export snapshot gains the four guards)

**Interfaces:**
- Consumes: W1's `CommandRequest`, `Chunk`, `StreamEnd`, `StreamFail`, `StreamCredit`, `isId`, `isSocketError`.
- Produces (exported from `@spinajs/http-socket-common`, and so from `@spinajs/http-socket` and `@spinajs/http-socket-client`):
  - `CommandRequest.credits?: number`. `isCommandRequest` accepts it only as an integer above 0.
  - `isChunk(v): v is Chunk`: `id` is an id and `seq` an integer ≥ 0. `data` is not required.
  - `isStreamEnd(v): v is StreamEnd`: `id`, and `seq` an integer ≥ 0.
  - `isStreamFail(v): v is StreamFail`: `id`, and `error` a `SocketError`.
  - `isStreamCredit(v): v is StreamCredit`: `id`, and `credits` an integer above 0.

- [ ] **Step 1: Write the failing tests**

In `packages/http-socket-common/test/common.test.ts`, add this line directly after the existing import from `'../src/index.js'`:

```ts
import { isChunk, isStreamCredit, isStreamEnd, isStreamFail } from '../src/index.js';
```

Then replace the line `  describe('contracts', () => {` with:

```ts
  describe('stream frames', () => {
    it('accepts a credits field on a command request only as an integer above 0', () => {
      expect(isCommandRequest({ id: 'r1', name: 'docs.snapshot', credits: 8 })).to.be.true;
      for (const credits of [0, -1, 1.5, '8', Number.NaN, Number.POSITIVE_INFINITY, null]) {
        expect(isCommandRequest({ id: 'r1', name: 'docs.snapshot', credits }), String(credits)).to.be.false;
      }
    });

    it('checks chunk and end frames: an id and a sequence number of at least 0', () => {
      expect(isChunk({ id: 'r1', seq: 0, data: { a: 1 } })).to.be.true;
      // an undefined item travels without its data field
      expect(isChunk({ id: 'r1', seq: 3 })).to.be.true;
      for (const frame of [{ id: 'r1', seq: -1, data: 1 }, { id: 'r1', seq: 0.5, data: 1 }, { id: 'r 1', seq: 0, data: 1 }, { seq: 0 }, null, 'chunk']) {
        expect(isChunk(frame), JSON.stringify(frame)).to.be.false;
      }

      expect(isStreamEnd({ id: 'r1', seq: 0 })).to.be.true;
      expect(isStreamEnd({ id: 'r1', seq: 12 })).to.be.true;
      expect(isStreamEnd({ id: 'r1' })).to.be.false;
      expect(isStreamEnd({ id: 'r1', seq: '1' })).to.be.false;
    });

    it('checks fail frames: an id and a wire error', () => {
      expect(isStreamFail({ id: 'r1', error: { code: 'internal', message: 'x', retryable: false } })).to.be.true;
      expect(isStreamFail({ id: 'r1', error: { code: 'teapot', message: 'x', retryable: false } })).to.be.false;
      expect(isStreamFail({ id: 'r1' })).to.be.false;
    });

    it('checks credit frames: an id and an integer above 0', () => {
      expect(isStreamCredit({ id: 'r1', credits: 4 })).to.be.true;
      for (const credits of [0, -2, 1.5, '4', Number.NaN]) {
        expect(isStreamCredit({ id: 'r1', credits }), String(credits)).to.be.false;
      }
      expect(isStreamCredit({ credits: 4 })).to.be.false;
      expect(isStreamCredit(null)).to.be.false;
    });
  });

  describe('contracts', () => {
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: FAIL. Either the new imports do not exist (`has no exported member 'isChunk'`), or, when the runner transpiles without type checks, `isChunk is not a function`.

- [ ] **Step 3: Implement the protocol additions**

In `packages/http-socket-common/src/protocol.ts`:

1. Replace the first line `import { SocketError } from './errors.js';` with:

```ts
import { SocketError, isSocketError } from './errors.js';
```

2. In `interface CommandRequest`, replace

```ts
  traceparent?: string;
}

export interface CommandResultReply<R = unknown> {
```

with

```ts
  traceparent?: string;
  /**
   * Stream commands only: chunks the server may send before the client grants more. A stream
   * command called without it is refused, so a plain `command()` never opens a stream.
   */
  credits?: number;
}

export interface CommandResultReply<R = unknown> {
```

3. Replace the whole `isCommandRequest` function with:

```ts
function isCreditCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isCommandRequest(value: unknown): value is CommandRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isId(value.id) &&
    isName(value.name) &&
    (value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string') &&
    (value.deadline === undefined || (typeof value.deadline === 'number' && Number.isFinite(value.deadline))) &&
    (value.traceparent === undefined || typeof value.traceparent === 'string') &&
    (value.credits === undefined || isCreditCount(value.credits))
  );
}
```

4. Append at the end of the file:

```ts
export function isChunk(value: unknown): value is Chunk {
  return isRecord(value) && isId(value.id) && isSeq(value.seq);
}

export function isStreamEnd(value: unknown): value is StreamEnd {
  return isRecord(value) && isId(value.id) && isSeq(value.seq);
}

export function isStreamFail(value: unknown): value is StreamFail {
  return isRecord(value) && isId(value.id) && isSocketError(value.error);
}

export function isStreamCredit(value: unknown): value is StreamCredit {
  return isRecord(value) && isId(value.id) && isCreditCount(value.credits);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-common && npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: PASS, 0 failing (the earlier tests plus 4 new ones).

- [ ] **Step 5: Build common and update the server's export snapshot**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-common/tsconfig.mjs.json packages/http-socket-common/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0.

In `packages/http-socket/test/exports.test.ts`, replace

```ts
  'isCancelFrame',
  'isCommandRequest',
```

with

```ts
  'isCancelFrame',
  'isChunk',
  'isCommandRequest',
```

and replace

```ts
  'isSocketError',
  'observeCommand',
```

with

```ts
  'isSocketError',
  'isStreamCredit',
  'isStreamEnd',
  'isStreamFail',
  'observeCommand',
```

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/exports.test.ts`
Expected: PASS (3 passing).

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/index.test.ts`
Expected: PASS. It only checks that names are present, so it needs no change.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-common/src/protocol.ts packages/http-socket-common/test/common.test.ts packages/http-socket/test/exports.test.ts && \
git commit -m "feat(http-socket-common): stream credits on the request and guards for chunk, end, fail and credit frames"
```

---

### Task 2: `ServerStream`, the credit-gated pump

**Files:**
- Create: `packages/http-socket/src/stream.ts`
- Test: `packages/http-socket/test/stream.test.ts`

**Interfaces:**
- Consumes: `untilAborted(promise, signal)` from `src/limits.ts` (internal); `SocketException`, `WIRE_EVENTS`, `Chunk`, `StreamEnd`, `StreamFail`, `SocketError` and `ErrorCode` from common.
- Produces (internal to the package; not exported from `src/index.ts`):
  - `type StreamFrameEvent` (`typeof WIRE_EVENTS.chunk | .end | .fail`)
  - `type StreamOutcome = 'ok' | ErrorCode`
  - `interface IServerStreamInit { id; name; iterator: AsyncIterator<unknown>; signal: AbortSignal; abort(reason: SocketException): void; credits: number; maxCredits: number; stallTimeoutMs: number; send(event: StreamFrameEvent, frame: Chunk | StreamEnd | StreamFail): void; within<T>(step: () => Promise<T>): Promise<T>; toWire(error: unknown): SocketError }`
  - `class ServerStream { constructor(init: IServerStreamInit); get sent(): number; grant(credits: number): void; run(): Promise<StreamOutcome> }`, where:
    - `run()` never rejects.
    - A `grant()` that would leave more than `maxCredits` outstanding calls `abort(invalid_argument)`.
    - `stallTimeoutMs` without credit calls `abort(deadline_exceeded)`.
    - Any failure sends one `fail` frame, calls `abort` with the mapped error, and starts the iterator's `return()` without awaiting it.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/http-socket/test/stream.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import type { SocketError } from '@spinajs/http-socket-common';
import { IServerStreamInit, ServerStream } from '../src/stream.js';

interface IFrame {
  event: string;
  frame: Record<string, unknown>;
}

interface ISourceLog {
  produced: number;
  finallyRan: boolean;
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await tick(5);
  }
}

function toWire(err: unknown): SocketError {
  return err instanceof SocketException ? err.toWire() : { code: 'internal', message: err instanceof Error ? err.message : String(err), retryable: false };
}

function counter(log: ISourceLog, n = Number.POSITIVE_INFINITY): AsyncGenerator<number> {
  return (async function* () {
    try {
      for (let i = 0; i < n; i++) {
        log.produced++;
        yield i;
      }
    } finally {
      log.finallyRan = true;
    }
  })();
}

function setup(iterator: AsyncIterator<unknown>, patch: Partial<IServerStreamInit> = {}) {
  const controller = new AbortController();
  const frames: IFrame[] = [];
  const stream = new ServerStream({
    id: 's-1',
    name: 'strm.unit',
    iterator,
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    credits: 2,
    maxCredits: 8,
    stallTimeoutMs: 5_000,
    send: (event, frame) => {
      frames.push({ event, frame: frame as unknown as Record<string, unknown> });
    },
    within: (step) => step(),
    toWire,
    ...patch,
  });

  const data = () => frames.filter((f) => f.event === WIRE_EVENTS.chunk).map((f) => f.frame.data);
  const last = () => frames[frames.length - 1];
  return { stream, frames, controller, data, last };
}

describe('ServerStream', () => {
  it('sends no more chunks than its credit, and asks the source for nothing beyond it', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data } = setup(counter(log));

    void stream.run();
    await tick();

    expect(data()).to.deep.equal([0, 1]);
    expect(log.produced).to.equal(2);
    expect(stream.sent).to.equal(2);
  });

  it('continues as credit arrives and ends with the number of chunks sent', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data, last } = setup(counter(log, 3));

    const outcome = stream.run();
    await tick();
    // one for the last chunk, one to find the end
    stream.grant(2);

    expect(await outcome).to.equal('ok');
    expect(data()).to.deep.equal([0, 1, 2]);
    expect(last()).to.deep.equal({ event: WIRE_EVENTS.end, frame: { id: 's-1', seq: 3 } });
  });

  it('numbers chunks from 0 and sends an undefined item as null', async () => {
    const { stream, frames } = setup(
      (async function* () {
        yield undefined;
      })(),
    );

    expect(await stream.run()).to.equal('ok');
    expect(frames[0]).to.deep.equal({ event: WIRE_EVENTS.chunk, frame: { id: 's-1', seq: 0, data: null } });
  });

  it('sends the mapped error after the chunks already sent when the source throws, and fires the signal', async () => {
    const { stream, data, last, controller } = setup(
      (async function* () {
        yield 'a';
        throw new SocketException('not_found', 'the rest is gone');
      })(),
    );

    expect(await stream.run()).to.equal('not_found');
    expect(data()).to.deep.equal(['a']);
    expect(last()).to.deep.equal({ event: WIRE_EVENTS.fail, frame: { id: 's-1', error: { code: 'not_found', message: 'the rest is gone', retryable: false } } });
    expect(controller.signal.aborted).to.be.true;
  });

  it('fails with the abort reason and runs the source finally block when aborted while waiting for credit', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, last, controller } = setup(counter(log), { credits: 1 });

    const outcome = stream.run();
    await tick();
    controller.abort(new SocketException('cancelled', 'cancelled by the client'));

    expect(await outcome).to.equal('cancelled');
    expect((last().frame.error as SocketError).code).to.equal('cancelled');
    await until(() => log.finallyRan);
  });

  it('fails a stream that gets no credit within stallTimeoutMs with deadline_exceeded', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, last, controller } = setup(counter(log), { credits: 1, stallTimeoutMs: 50 });

    expect(await stream.run()).to.equal('deadline_exceeded');
    expect(last().frame.error).to.deep.include({ code: 'deadline_exceeded', retryable: true });
    expect((controller.signal.reason as SocketException).code).to.equal('deadline_exceeded');
    await until(() => log.finallyRan);
  });

  it('fails the stream with invalid_argument when a grant would leave more than maxCredits outstanding', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, last } = setup(counter(log), { credits: 2, maxCredits: 4 });

    const outcome = stream.run();
    await tick();
    stream.grant(5);

    expect(await outcome).to.equal('invalid_argument');
    expect(last().frame.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
  });

  it('accepts grants up to maxCredits outstanding', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, data } = setup(counter(log), { credits: 2, maxCredits: 4 });

    void stream.run();
    await tick();
    stream.grant(4);
    await tick();

    expect(data()).to.deep.equal([0, 1, 2, 3, 4, 5]);
  });

  it('fails with internal when a chunk cannot be sent', async () => {
    const frames: IFrame[] = [];
    const { stream } = setup(
      (async function* () {
        yield 1n;
      })(),
      {
        send: (event, frame) => {
          if (event === WIRE_EVENTS.chunk) {
            throw new TypeError('Do not know how to serialize a BigInt');
          }
          frames.push({ event, frame: frame as unknown as Record<string, unknown> });
        },
      },
    );

    expect(await stream.run()).to.equal('internal');
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.fail]);
  });

  it('runs every step of the source through within()', async () => {
    const als = new AsyncLocalStorage<{ tag: string }>();
    const { stream, data } = setup(
      (async function* () {
        for (let i = 0; i < 2; i++) {
          await tick(5);
          yield als.getStore()?.tag ?? null;
        }
      })(),
      { credits: 4, within: (step) => als.run({ tag: 'call-store' }, step) },
    );

    expect(await stream.run()).to.equal('ok');
    expect(data()).to.deep.equal(['call-store', 'call-store']);
  });

  it('fails at once, without starting the source, when its signal fired before run()', async () => {
    const log: ISourceLog = { produced: 0, finallyRan: false };
    const { stream, frames, controller } = setup(counter(log));
    controller.abort(new SocketException('unavailable', 'connection closed'));

    expect(await stream.run()).to.equal('unavailable');
    expect(log.produced).to.equal(0);
    expect(frames.map((f) => f.event)).to.deep.equal([WIRE_EVENTS.fail]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/stream.test.ts`
Expected: FAIL with `Cannot find module '../src/stream.js'`.

- [ ] **Step 3: Implement `ServerStream`**

Create `packages/http-socket/src/stream.ts`:

```ts
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import type { Chunk, ErrorCode, SocketError, StreamEnd, StreamFail } from '@spinajs/http-socket-common';
import { untilAborted } from './limits.js';

export type StreamFrameEvent = typeof WIRE_EVENTS.chunk | typeof WIRE_EVENTS.end | typeof WIRE_EVENTS.fail;

/** How a stream ended: 'ok' after its `end` frame, else the code of its `fail` frame. */
export type StreamOutcome = 'ok' | ErrorCode;

export interface IServerStreamInit {
  /** request id of the command; every frame carries it */
  readonly id: string;
  /** full command name, for messages */
  readonly name: string;
  readonly iterator: AsyncIterator<unknown>;
  /** the command's signal: cancel, disconnect, shutdown, a stall and a refused grant fire it */
  readonly signal: AbortSignal;
  abort(reason: SocketException): void;
  /** credit sent with the request, at most `maxCredits` */
  readonly credits: number;
  readonly maxCredits: number;
  readonly stallTimeoutMs: number;
  /** emits one frame; throws when socket.io cannot encode it */
  send(event: StreamFrameEvent, frame: Chunk | StreamEnd | StreamFail): void;
  /** runs one step of the source inside the call's AsyncLocalStorage store */
  within<T>(step: () => Promise<T>): Promise<T>;
  toWire(error: unknown): SocketError;
}

/**
 * The server side of one stream reply. It asks the source for the next item only while the client
 * has credit for it, so a slow consumer slows the producer instead of filling buffers.
 */
export class ServerStream {
  protected credits: number;
  protected seq = 0;
  protected wake: (() => void) | null = null;

  constructor(protected readonly init: IServerStreamInit) {
    this.credits = init.credits;
  }

  /** Chunks sent so far. */
  public get sent(): number {
    return this.seq;
  }

  public grant(credits: number): void {
    if (this.init.signal.aborted) {
      return;
    }

    if (this.credits + credits > this.init.maxCredits) {
      this.init.abort(new SocketException('invalid_argument', `stream credit above the limit of ${this.init.maxCredits} chunks`, { details: { limit: this.init.maxCredits } }));
      return;
    }

    this.credits += credits;
    this.wake?.();
  }

  /** Runs the stream to its `end` or `fail` frame; never rejects. */
  public async run(): Promise<StreamOutcome> {
    const id = this.init.id;

    try {
      for (;;) {
        await this.creditAvailable();
        const step = await untilAborted(
          this.init.within(() => this.init.iterator.next()),
          this.init.signal,
        );

        if (step.done) {
          this.init.send(WIRE_EVENTS.end, { id, seq: this.seq });
          return 'ok';
        }

        this.init.send(WIRE_EVENTS.chunk, { id, seq: this.seq, data: step.value === undefined ? null : step.value });
        this.seq++;
        this.credits--;
      }
    } catch (err) {
      return this.fail(err);
    }
  }

  protected fail(err: unknown): ErrorCode {
    const error = this.init.toWire(err);
    // a source still awaiting something learns to stop; a no-op when an abort is what ended the stream
    this.init.abort(SocketException.fromWire(error));

    try {
      this.init.send(WIRE_EVENTS.fail, { id: this.init.id, error });
    } catch {
      // nothing more can reach this client
    }

    // not awaited: return() waits for a pending next(), which a source that ignores its signal never settles
    this.init.within(async () => this.init.iterator.return?.(undefined)).catch(() => undefined);
    return error.code;
  }

  protected creditAvailable(): Promise<void> {
    const signal = this.init.signal;

    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }

    if (this.credits > 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const stall = setTimeout(() => this.init.abort(new SocketException('deadline_exceeded', `stream ${this.init.name} got no credit for ${this.init.stallTimeoutMs} ms`)), this.init.stallTimeoutMs);
      stall.unref?.();

      const settle = () => {
        clearTimeout(stall);
        signal.removeEventListener('abort', onAbort);
        this.wake = null;
      };
      const onAbort = () => {
        settle();
        reject(signal.reason);
      };

      this.wake = () => {
        settle();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/stream.test.ts`
Expected: PASS, 11 passing.

- [ ] **Step 5: Type-check the package source**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/stream.ts packages/http-socket/test/stream.test.ts && \
git commit -m "feat(http-socket): ServerStream pulls one item per unit of client credit"
```

---

### Task 3: Stream replies in the dispatcher

**Files:**
- Modify: `packages/http-socket/src/interfaces.ts` (`ISocketStreamsConfig`, `ISocketServerConfig.streams`, `IConnectionRuntime.streams`)
- Modify: `packages/http-socket/src/config/http-socket.ts` (`streams` block)
- Modify: `packages/http-socket/src/limits.ts` (`assertStreamsConfig`)
- Modify: `packages/http-socket/src/context.ts` (`stream` field)
- Modify: `packages/http-socket/src/dispatcher.ts` (imports, `sockets`, `resolve`, `attach`, `execute`, `onCommand`, `onCredit`, `toReply`, `openStream`, `runStream`)
- Create: `packages/http-socket/test/stream-client.ts` (raw stream helper)
- Test: `packages/http-socket/test/streams.test.ts`, `packages/http-socket/test/stream-config.test.ts`
- Modify: `packages/http-socket/test/pipeline.test.ts:181-185` (the W1 "unimplemented until W4" test)

**Interfaces:**
- Consumes:
  - Task 1: `CommandRequest.credits`, `isStreamCredit`.
  - Task 2: `ServerStream`, `IServerStreamInit`, `StreamOutcome`.
  - W1: `SocketCommandContext`, `IConnectionRuntime.running`, `IN_FLIGHT_RETRY_AFTER_MS` (`src/stages/limits.ts`), `SocketErrorMapper.toWire`.
- Produces:
  - `interface ISocketStreamsConfig { maxCredits: number; maxPerConnection: number; stallTimeoutMs: number }`, set as `ISocketServerConfig.streams`.
  - `IConnectionRuntime.streams: number`: open streams.
  - `SocketCommandContext.stream?: ServerStream`.
  - `assertStreamsConfig(options: Pick<ISocketServerConfig, 'streams'>): void` (internal): throws `RangeError`.
  - `SocketDispatcher`:
    - `protected openStream(ctx, source): ServerStream`
    - `protected runStream(ctx, stream): void` (Task 4 replaces its body)
    - `protected onCredit(runtime, frame): void`
  - Wire behaviour:
    - A handler returning an async iterable answers `{ id, ok: true, stream: true }`, then `chunk`, then `end` or `fail`.
    - Without `credits` the answer is `failed_precondition`.
    - Above `streams.maxCredits` the answer is `invalid_argument` with `details { limit }`.
    - Beyond `streams.maxPerConnection` the answer is `resource_exhausted` with `retryAfterMs: 100`.
    - The request id stays in flight until the stream ends.

- [ ] **Step 1: Write the raw stream helper**

Create `packages/http-socket/test/stream-client.ts`:

```ts
import { Socket as ClientSocket } from 'socket.io-client';
import { CancelFrame, Chunk, CommandReply, CommandRequest, StreamCredit, StreamEnd, StreamFail, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { nextId } from './harness.js';

/** One stream command driven by hand over a raw socket.io client: the test grants credit and cancels. */
export interface IRawStream {
  readonly id: string;
  readonly reply: Promise<CommandReply>;
  readonly chunks: Chunk[];
  readonly end: StreamEnd | null;
  readonly fail: StreamFail | null;
  /** settles on the `end` or `fail` frame */
  readonly finished: Promise<void>;
  grant(credits: number): void;
  cancel(): void;
}

/** @param credits - the request's initial window; undefined sends a request without it */
export function rawStream(socket: ClientSocket, name: string, payload: unknown, credits: number | undefined, extra: Partial<CommandRequest> = {}): IRawStream {
  const id = extra.id ?? nextId();
  const chunks: Chunk[] = [];
  let settle: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const state = { end: null as StreamEnd | null, fail: null as StreamFail | null };
  const onChunk = (frame: Chunk) => {
    if (frame.id === id) {
      chunks.push(frame);
    }
  };
  const done = () => {
    socket.off(WIRE_EVENTS.chunk, onChunk);
    socket.off(WIRE_EVENTS.end, onEnd);
    socket.off(WIRE_EVENTS.fail, onFail);
    settle();
  };
  const onEnd = (frame: StreamEnd) => {
    if (frame.id === id) {
      state.end = frame;
      done();
    }
  };
  const onFail = (frame: StreamFail) => {
    if (frame.id === id) {
      state.fail = frame;
      done();
    }
  };

  // listening before the request goes out, so no frame can be missed
  socket.on(WIRE_EVENTS.chunk, onChunk);
  socket.on(WIRE_EVENTS.end, onEnd);
  socket.on(WIRE_EVENTS.fail, onFail);

  const request: CommandRequest = { id, name, payload, ...extra };
  if (credits !== undefined) {
    request.credits = credits;
  }

  return {
    id,
    reply: socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, request) as Promise<CommandReply>,
    chunks,
    get end() {
      return state.end;
    },
    get fail() {
      return state.fail;
    },
    finished,
    grant: (n: number) => {
      const frame: StreamCredit = { id, credits: n };
      socket.emit(WIRE_EVENTS.credit, frame);
    },
    cancel: () => {
      const frame: CancelFrame = { id };
      socket.emit(WIRE_EVENTS.cancel, frame);
    },
  };
}
```

- [ ] **Step 2: Write the failing end-to-end tests**

Create `packages/http-socket/test/streams.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, Signal, SocketController } from '../src/decorators.js';
import { ITestServer, command, delay, errorOf, open, startServer, waitFor } from './harness.js';
import { rawStream } from './stream-client.js';

export const strmLog = {
  produced: new Map<string, number>(),
  finallyRan: new Set<string>(),
  aborts: new Map<string, unknown>(),
  reset(): void {
    this.produced.clear();
    this.finallyRan.clear();
    this.aborts.clear();
  },
};

@SocketController('strm')
export class StrmSocket extends BaseSocketController {
  @Command('count')
  public async *count(@Payload() p: { key: string; n?: number }, @Signal() signal: AbortSignal) {
    signal.addEventListener('abort', () => strmLog.aborts.set(p.key, signal.reason), { once: true });
    try {
      for (let i = 0; i < (p.n ?? Number.POSITIVE_INFINITY); i++) {
        strmLog.produced.set(p.key, i + 1);
        yield i;
      }
    } finally {
      strmLog.finallyRan.add(p.key);
    }
  }

  @Command('broken')
  public async *broken() {
    yield 'first';
    throw new ResourceNotFound('the rest is gone');
  }

  @Command('store')
  public async *store() {
    const als = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;
    for (let i = 0; i < 2; i++) {
      await delay(5);
      yield als.getStore()?.requestId ?? null;
    }
  }

  @Command('binary')
  public async *binary() {
    yield new Uint8Array([1, 2, 3]);
    yield { part: new Uint8Array([4, 5]) };
  }

  @Command('bigint')
  public async *bigint() {
    yield 1n;
  }

  @Command('empty')
  public async *empty() {
    // ends without an item
  }

  @Command('void')
  public async *nothing() {
    yield undefined;
  }
}

describe('stream replies', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    strmLog.reset();
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('acks a stream reply, then sends only as many chunks as the client granted', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'slow' }, 2);

    expect(await s.reply).to.deep.equal({ id: s.id, ok: true, stream: true });
    await waitFor(() => s.chunks.length === 2);
    await delay(100);

    expect(s.chunks).to.deep.equal([
      { id: s.id, seq: 0, data: 0 },
      { id: s.id, seq: 1, data: 1 },
    ]);
    // spec §7: the slow consumer has no more chunks in flight than its credit, and the generator was not asked for more
    expect(strmLog.produced.get('slow')).to.equal(2);
  });

  it('sends more chunks as credit arrives and ends with the chunk count', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'five', n: 5 }, 2);
    await waitFor(() => s.chunks.length === 2);

    // three for the remaining chunks, one to find the end
    s.grant(4);
    await s.finished;

    expect(s.chunks.map((c) => c.data)).to.deep.equal([0, 1, 2, 3, 4]);
    expect(s.end).to.deep.equal({ id: s.id, seq: 5 });
    await waitFor(() => strmLog.finallyRan.has('five'));
  });

  it('ends an empty stream at once and sends undefined items as null', async () => {
    const empty = rawStream(socket, 'strm.empty', null, 1);
    await empty.finished;
    expect(empty.end).to.deep.equal({ id: empty.id, seq: 0 });

    const nothing = rawStream(socket, 'strm.void', null, 2);
    await nothing.finished;
    expect(nothing.chunks).to.deep.equal([{ id: nothing.id, seq: 0, data: null }]);
    expect(nothing.end).to.deep.equal({ id: nothing.id, seq: 1 });
  });

  it('cancel runs the generator finally block and fires its signal with cancelled', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'cancel' }, 1);
    await waitFor(() => s.chunks.length === 1);

    s.cancel();
    await s.finished;

    expect(s.fail?.error.code).to.equal('cancelled');
    await waitFor(() => strmLog.finallyRan.has('cancel'));
    expect((strmLog.aborts.get('cancel') as SocketException).code).to.equal('cancelled');
  });

  it('a disconnect stops the stream with unavailable and runs the generator finally block', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'gone' }, 1);
    await waitFor(() => s.chunks.length === 1);

    socket.close();

    await waitFor(() => strmLog.finallyRan.has('gone'));
    expect((strmLog.aborts.get('gone') as SocketException).code).to.equal('unavailable');
  });

  it('sends the mapped error as a fail frame after the chunks before it', async () => {
    const s = rawStream(socket, 'strm.broken', null, 4);
    await s.finished;

    expect(s.chunks.map((c) => c.data)).to.deep.equal(['first']);
    expect(s.fail?.error).to.deep.include({ code: 'not_found', message: 'the rest is gone', retryable: false });
  });

  it('fails with internal when a chunk cannot be encoded', async () => {
    const s = rawStream(socket, 'strm.bigint', null, 1);
    await s.finished;

    expect(s.chunks).to.deep.equal([]);
    expect(s.fail?.error.code).to.equal('internal');
  });

  it('pulls every chunk inside the call store, after the ack', async () => {
    const s = rawStream(socket, 'strm.store', null, 4, { id: 'store-stream-1' });
    await s.finished;

    expect(s.chunks.map((c) => c.data)).to.deep.equal(['store-stream-1', 'store-stream-1']);
  });

  it('carries binary chunk parts as attachments', async () => {
    const s = rawStream(socket, 'strm.binary', null, 4);
    await s.finished;

    expect(Array.from(new Uint8Array(s.chunks[0].data as ArrayBuffer))).to.deep.equal([1, 2, 3]);
    expect(Array.from(new Uint8Array((s.chunks[1].data as { part: ArrayBuffer }).part))).to.deep.equal([4, 5]);
  });

  it('answers a stream command sent without credits with failed_precondition and never starts the generator', async () => {
    const error = errorOf(await command(socket, 'strm.count', { key: 'plain' }));

    expect(error.code).to.equal('failed_precondition');
    expect(error.message).to.match(/open it as a stream/);
    expect(strmLog.produced.has('plain')).to.be.false;
  });

  it('keeps an open stream id in flight until the stream ends', async () => {
    const s = rawStream(socket, 'strm.count', { key: 'dup' }, 1, { id: 'dup-stream' });
    await s.reply;

    expect(errorOf(await command(socket, 'strm.count', { key: 'dup2' }, { id: 'dup-stream', credits: 1 }))).to.deep.equal({ code: 'invalid_argument', message: 'request id already in flight', retryable: false });

    s.cancel();
    await s.finished;
    await delay(20);

    const again = rawStream(socket, 'strm.count', { key: 'dup3', n: 1 }, 2, { id: 'dup-stream' });
    await again.finished;
    expect(again.end).to.deep.equal({ id: 'dup-stream', seq: 1 });
  });

  it('ignores credit for unknown ids and malformed credit frames', async () => {
    socket.emit(WIRE_EVENTS.credit, { id: 'nobody', credits: 5 });
    socket.emit(WIRE_EVENTS.credit, { id: 'x', credits: -1 });
    socket.emit(WIRE_EVENTS.credit, 'garbage');

    const s = rawStream(socket, 'strm.count', { key: 'after-garbage', n: 1 }, 2);
    await s.finished;
    expect(s.end).to.deep.equal({ id: s.id, seq: 1 });
  });

  describe('limits', () => {
    beforeEach(async () => {
      socket.close();
      await t.close();
      t = await startServer({ http: { socket: { streams: { maxCredits: 4, maxPerConnection: 1, stallTimeoutMs: 300 } } } });
      socket = await open(t);
    });

    it('refuses an initial credit above streams.maxCredits with invalid_argument, without starting the generator', async () => {
      const reply = await rawStream(socket, 'strm.count', { key: 'greedy' }, 5).reply;

      expect(errorOf(reply)).to.deep.include({ code: 'invalid_argument', details: { limit: 4 }, retryable: false });
      expect(strmLog.produced.has('greedy')).to.be.false;
    });

    it('fails a stream when a grant would leave more than maxCredits outstanding', async () => {
      const s = rawStream(socket, 'strm.count', { key: 'over' }, 4);
      await waitFor(() => s.chunks.length === 4);

      s.grant(5);
      await s.finished;

      expect(s.fail?.error).to.deep.include({ code: 'invalid_argument', details: { limit: 4 } });
      await waitFor(() => strmLog.finallyRan.has('over'));
    });

    it('refuses a stream beyond streams.maxPerConnection with resource_exhausted, and frees the slot when one ends', async () => {
      const first = rawStream(socket, 'strm.count', { key: 'cap-1' }, 1);
      await first.reply;

      const second = await rawStream(socket, 'strm.count', { key: 'cap-2' }, 1).reply;
      expect(errorOf(second)).to.deep.include({ code: 'resource_exhausted', retryable: true, retryAfterMs: 100 });

      first.cancel();
      await first.finished;
      await delay(20);

      const third = rawStream(socket, 'strm.count', { key: 'cap-3', n: 1 }, 2);
      await third.finished;
      expect(third.end).to.deep.equal({ id: third.id, seq: 1 });
    });

    it('fails a stream that gets no credit for stallTimeoutMs with deadline_exceeded', async () => {
      const s = rawStream(socket, 'strm.count', { key: 'stalled' }, 1);
      await s.finished;

      expect(s.chunks).to.have.length(1);
      expect(s.fail?.error).to.deep.include({ code: 'deadline_exceeded', retryable: true });
      expect((strmLog.aborts.get('stalled') as SocketException).code).to.equal('deadline_exceeded');
    });
  });
});
```

Create `packages/http-socket/test/stream-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import socketConfig from '../src/config/http-socket.js';
import { assertStreamsConfig } from '../src/limits.js';
import { startServer } from './harness.js';

describe('stream reply configuration', function () {
  this.timeout(15000);

  const ok = { streams: { maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 60_000 } };

  it('ships the stream defaults', () => {
    expect(socketConfig.http.socket.streams).to.deep.equal(ok.streams);
  });

  it('accepts the defaults', () => {
    expect(() => assertStreamsConfig(ok)).not.to.throw();
  });

  it('refuses a missing block and values that are not integers above 0', () => {
    expect(() => assertStreamsConfig({} as typeof ok)).to.throw(RangeError);

    for (const key of ['maxCredits', 'maxPerConnection', 'stallTimeoutMs'] as const) {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8', undefined]) {
        expect(() => assertStreamsConfig({ streams: { ...ok.streams, [key]: bad } } as typeof ok), `${key} ${String(bad)}`).to.throw(RangeError);
      }
    }
  });

  it('refuses a stall timeout above the longest timer delay', () => {
    expect(() => assertStreamsConfig({ streams: { ...ok.streams, stallTimeoutMs: 2 ** 31 } })).to.throw(RangeError);
  });

  it('refuses to start the server with a bad streams block', async () => {
    await expect(startServer({ http: { socket: { streams: { maxCredits: 0 } } } })).to.be.rejectedWith(RangeError, /streams\.maxCredits/);
  });
});
```

In `packages/http-socket/test/pipeline.test.ts`, replace

```ts
  it('answers a stream-returning handler with unimplemented until W4', async () => {
    const error = errorOf(await command(socket, 'pipe.stream'));
    expect(error.code).to.equal('unimplemented');
    expect(error.message).to.match(/stream replies/);
  });
```

with

```ts
  it('answers a stream-returning handler called without credits with failed_precondition', async () => {
    const error = errorOf(await command(socket, 'pipe.stream'));
    expect(error.code).to.equal('failed_precondition');
    expect(error.message).to.match(/open it as a stream/);
  });
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/streams.test.ts test/stream-config.test.ts test/pipeline.test.ts`
Expected: FAIL. `assertStreamsConfig` does not exist yet, and stream commands still answer `unimplemented`, so `acks a stream reply` fails on the reply.

- [ ] **Step 4: Add the configuration**

In `packages/http-socket/src/interfaces.ts`, replace

```ts
export interface ISocketAuthConfig {
```

with

```ts
export interface ISocketStreamsConfig {
  /** largest credit window a client may grant one stream; a larger request or grant fails it with invalid_argument */
  maxCredits: number;
  /** streams open on one connection at once; they hold no command in-flight slot */
  maxPerConnection: number;
  /** a stream left without credit this long fails with deadline_exceeded */
  stallTimeoutMs: number;
}

export interface ISocketAuthConfig {
```

replace

```ts
  hooks: { connectTimeoutMs: number };
```

with

```ts
  hooks: { connectTimeoutMs: number };
  /** stream replies ( W4 ) */
  streams: ISocketStreamsConfig;
```

and replace

```ts
  /** events counted against maxInFlightEventsPerConnection, from arrival until their handler settles */
  eventsInFlight: number;
```

with

```ts
  /** events counted against maxInFlightEventsPerConnection, from arrival until their handler settles */
  eventsInFlight: number;
  /** stream replies open on this connection, from the stream reply until their end or fail frame */
  streams: number;
```

In `packages/http-socket/src/config/http-socket.ts`, replace

```ts
      hooks: {
        connectTimeoutMs: 10_000,
      },
```

with

```ts
      hooks: {
        connectTimeoutMs: 10_000,
      },
      streams: {
        maxCredits: 64,
        maxPerConnection: 8,
        stallTimeoutMs: 60_000,
      },
```

In `packages/http-socket/src/limits.ts`, replace

```ts
export function assertOrderingConfig(options: Pick<ISocketServerConfig, 'ordering'>): void {
```

with

```ts
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export function assertStreamsConfig(options: Pick<ISocketServerConfig, 'streams'>): void {
  const streams = options.streams;
  const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;

  if (!positiveInteger(streams?.maxCredits) || !positiveInteger(streams?.maxPerConnection)) {
    throw new RangeError(`http.socket.streams.maxCredits and maxPerConnection must be integers above 0, got maxCredits ${String(streams?.maxCredits)}, maxPerConnection ${String(streams?.maxPerConnection)}`);
  }

  if (!(positiveInteger(streams.stallTimeoutMs) && streams.stallTimeoutMs <= MAX_TIMER_DELAY_MS)) {
    throw new RangeError(`http.socket.streams.stallTimeoutMs must be an integer within 1 and ${MAX_TIMER_DELAY_MS}, got ${String(streams.stallTimeoutMs)}`);
  }
}

export function assertOrderingConfig(options: Pick<ISocketServerConfig, 'ordering'>): void {
```

In `packages/http-socket/src/context.ts`, replace

```ts
import { SocketConnection } from './connection.js';
```

with

```ts
import { SocketConnection } from './connection.js';
import type { ServerStream } from './stream.js';
```

and replace

```ts
  public rateRefusal?: unknown;
```

with

```ts
  public rateRefusal?: unknown;
  /** set when the handler returned an async iterable: the reply is a stream and this sends it */
  public stream?: ServerStream;
```

- [ ] **Step 5: Wire stream replies into the dispatcher**

In `packages/http-socket/src/dispatcher.ts`, make these replacements.

Imports. Replace

```ts
import { CommandReply, CommandRequest, ErrorCode, SocketException, WIRE_EVENTS, isCancelFrame, isCommandRequest, isEventFrame } from '@spinajs/http-socket-common';
```

with

```ts
import { CommandReply, CommandRequest, ErrorCode, SocketException, WIRE_EVENTS, isCancelFrame, isCommandRequest, isEventFrame, isStreamCredit } from '@spinajs/http-socket-common';
```

replace

```ts
import { TokenBucket, assertHooksConfig, assertLimitsConfig, assertOrderingConfig, assertPayloadSize, assertRate, untilAborted, withSlot } from './limits.js';
```

with

```ts
import { TokenBucket, assertHooksConfig, assertLimitsConfig, assertOrderingConfig, assertPayloadSize, assertRate, assertStreamsConfig, untilAborted, withSlot } from './limits.js';
```

and replace

```ts
import './stages/index.js';
```

with

```ts
import { ServerStream } from './stream.js';
import { IN_FLIGHT_RETRY_AFTER_MS } from './stages/limits.js';
import './stages/index.js';
```

Fields. Replace

```ts
  protected runtimes = new Map<string, IConnectionRuntime>();
```

with

```ts
  protected runtimes = new Map<string, IConnectionRuntime>();

  /** the socket of each runtime, which stream frames are written to */
  protected sockets = new WeakMap<IConnectionRuntime, Socket>();
```

`resolve()`. Replace

```ts
    assertHooksConfig(this.Options);
```

with

```ts
    assertHooksConfig(this.Options);
    assertStreamsConfig(this.Options);
```

`attach()`. Replace

```ts
      eventsInFlight: 0,
      running: new Map(),
```

with

```ts
      eventsInFlight: 0,
      streams: 0,
      running: new Map(),
```

and replace

```ts
    this.runtimes.set(connection.id, runtime);
    socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));
    socket.on(WIRE_EVENTS.cancel, (frame: unknown) => this.onCancel(runtime, frame));
```

with

```ts
    this.runtimes.set(connection.id, runtime);
    this.sockets.set(runtime, socket);
    socket.on(WIRE_EVENTS.command, (request: unknown, ack: unknown) => this.onCommand(runtime, request, ack));
    socket.on(WIRE_EVENTS.cancel, (frame: unknown) => this.onCancel(runtime, frame));
    socket.on(WIRE_EVENTS.credit, (frame: unknown) => this.onCredit(runtime, frame));
```

`execute()` (the `finally` block). Replace

```ts
      ctx.dispose();
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
```

with

```ts
      ctx.dispose();
      // an open stream keeps its id until it ends, so cancel, credit, disconnect and shutdown still find it
      if (!ctx.stream && runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
```

`onCommand()`. Replace

```ts
    void this.execute(ctx).then((answer) => this.send(reply, answer, raw.name));
```

with

```ts
    void this.execute(ctx).then((answer) => {
      this.send(reply, answer, raw.name);
      // after the ack, so the client knows the id is a stream before its first chunk
      if (ctx.stream) {
        this.runStream(ctx, ctx.stream);
      }
    });
```

`onCredit()` (new, after `onCancel`). Replace

```ts
    runtime.running.get(frame.id)?.abort(new SocketException('cancelled', `command ${frame.id} cancelled by the client`));
  }
```

with

```ts
    runtime.running.get(frame.id)?.abort(new SocketException('cancelled', `command ${frame.id} cancelled by the client`));
  }

  protected onCredit(runtime: IConnectionRuntime, frame: unknown): void {
    if (!isStreamCredit(frame)) {
      return;
    }

    const ctx = runtime.running.get(frame.id);
    if (ctx instanceof SocketCommandContext) {
      ctx.stream?.grant(frame.credits);
    }
  }
```

`toReply()`. Replace the whole method, from

```ts
  /** W4 replaces the stream branch with real stream replies. */
  protected async toReply(ctx: SocketCommandContext, result: unknown): Promise<CommandReply> {
```

to the end of the method, with:

```ts
  /** An async iterable result becomes a stream reply; its chunks follow the ack ( runStream ). */
  protected async toReply(ctx: SocketCommandContext, result: unknown): Promise<CommandReply> {
    if (!isAsyncIterable(result)) {
      return { id: ctx.request.id, ok: true, result: result === undefined ? null : result };
    }

    try {
      ctx.stream = this.openStream(ctx, result);
    } catch (err) {
      try {
        await (result as AsyncGenerator<unknown>).return?.(undefined);
      } catch {
        // a failing generator cleanup does not change the answer
      }
      throw err;
    }

    return { id: ctx.request.id, ok: true, stream: true };
  }

  protected openStream(ctx: SocketCommandContext, source: AsyncIterable<unknown>): ServerStream {
    const name = ctx.request.name;
    const credits = ctx.request.credits;
    const limits = this.Options.streams;
    const runtime = ctx.runtime;
    const socket = this.sockets.get(runtime);

    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }

    if (credits === undefined) {
      throw new SocketException('failed_precondition', `command ${name} replies with a stream; open it as a stream with credits`);
    }

    if (credits > limits.maxCredits) {
      throw new SocketException('invalid_argument', `stream credit above the limit of ${limits.maxCredits} chunks`, { details: { limit: limits.maxCredits } });
    }

    if (runtime.streams >= limits.maxPerConnection) {
      throw new SocketException('resource_exhausted', `more than ${limits.maxPerConnection} streams open on this connection`, { retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS });
    }

    if (!socket) {
      throw new SocketException('unavailable', 'connection closed');
    }

    const stream = new ServerStream({
      id: ctx.request.id,
      name,
      iterator: this.Als.run(ctx.storage, () => source[Symbol.asyncIterator]()),
      signal: ctx.signal,
      abort: (reason) => ctx.abort(reason),
      credits,
      maxCredits: limits.maxCredits,
      stallTimeoutMs: limits.stallTimeoutMs,
      send: (event, frame) => {
        socket.emit(event, frame);
      },
      within: (step) => this.Als.run(ctx.storage, step),
      toWire: (err) => this.Errors.toWire(err, `stream ${name}`),
    });

    runtime.streams++;
    return stream;
  }

  protected runStream(ctx: SocketCommandContext, stream: ServerStream): void {
    const runtime = ctx.runtime;

    void stream.run().then(() => {
      runtime.streams--;
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
    });
  }
```

- [ ] **Step 6: Type-check the server and run the new tests**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json`
Expected: exits 0.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/streams.test.ts test/stream-config.test.ts test/pipeline.test.ts`
Expected: PASS, 0 failing (streams: 16, config: 5, plus the pipeline tests).

- [ ] **Step 7: Run the whole server suite**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npm test`
Expected: 0 failing. Cancel, disconnect, deadline and shutdown tests still pass, because a plain command leaves the running map in `execute`'s `finally` as before.

- [ ] **Step 8: Build and commit**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0.

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/interfaces.ts packages/http-socket/src/config/http-socket.ts packages/http-socket/src/limits.ts packages/http-socket/src/context.ts packages/http-socket/src/dispatcher.ts packages/http-socket/test/stream-client.ts packages/http-socket/test/streams.test.ts packages/http-socket/test/stream-config.test.ts packages/http-socket/test/pipeline.test.ts && \
git commit -m "feat(http-socket): stream replies with credit flow control, per-connection cap and stall timeout"
```

---

### Task 4: Stream observability, export snapshot, release notes

**Files:**
- Modify: `packages/http-socket/src/metrics.ts` (`socket_streams_total`, `observeStream`)
- Modify: `packages/http-socket/src/dispatcher.ts` (`runStream` body, new `streamEnded` method, import)
- Test: `packages/http-socket/test/stream-observability.test.ts`
- Modify: `packages/http-socket/test/exports.test.ts`
- Modify: `packages/http-socket/RELEASE_NOTES.md`

**Interfaces:**
- Consumes: Task 3's `runStream`, `ServerStream.sent`, and `StreamOutcome`.
- Produces:
  - `SOCKET_METRIC_KEY_STREAMS = 'streams_total'`
  - `observeStream(command: string, code: string): void`, exported. Its metric is `socket_streams_total{command, code}`, where `code` is `ok` or the error code.
  - One debug line per stream: `socket stream <name> <outcome> <n> chunks <ms>ms connection <id>`.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/stream-observability.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { ITestServer, delay, open, startServer, waitFor } from './harness.js';
import { rawStream } from './stream-client.js';

@SocketController('strmobs')
export class StrmObsSocket extends BaseSocketController {
  @Command('two')
  public async *two() {
    yield 1;
    yield 2;
  }
}

describe('stream observability', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    sinon.restore();
    socket.close();
    await t.close();
  });

  it('counts ended streams by command and outcome', async () => {
    const ok = rawStream(socket, 'strmobs.two', null, 4);
    await ok.finished;

    const cancelled = rawStream(socket, 'strmobs.two', null, 1);
    await waitFor(() => cancelled.chunks.length === 1);
    cancelled.cancel();
    await cancelled.finished;
    await delay(20);

    const text = await (DI.resolve(Metrics) as Metrics).render();
    expect(text).to.contain('socket_streams_total{command="strmobs.two",code="ok"} 1');
    expect(text).to.contain('socket_streams_total{command="strmobs.two",code="cancelled"} 1');
    // the stream reply itself is one ok command
    expect(text).to.contain('socket_commands_total{command="strmobs.two",code="ok"} 2');
  });

  it('writes one debug line per stream', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    const debug = sinon.spy((dispatcher as unknown as { Log: { debug: (...args: unknown[]) => void } }).Log, 'debug');

    const s = rawStream(socket, 'strmobs.two', null, 4);
    await s.finished;
    await delay(20);

    const lines = debug.getCalls().map((c) => String(c.args[0]));
    expect(lines.some((line) => /^socket stream strmobs\.two ok 2 chunks \d+ms connection /.test(line))).to.be.true;
  });
});
```

In `packages/http-socket/test/exports.test.ts`, replace

```ts
  'SOCKET_METRIC_KEY_DURATION',
  'SOCKET_METRIC_PREFIX',
```

with

```ts
  'SOCKET_METRIC_KEY_DURATION',
  'SOCKET_METRIC_KEY_STREAMS',
  'SOCKET_METRIC_PREFIX',
```

replace

```ts
  'observeCommand',
  'payloadSize',
```

with

```ts
  'observeCommand',
  'observeStream',
  'payloadSize',
```

and in the internal-helpers test, replace

```ts
'SerialQueue', 'policyRequest']) {
```

with

```ts
'SerialQueue', 'policyRequest', 'ServerStream', 'assertStreamsConfig']) {
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/stream-observability.test.ts test/exports.test.ts`
Expected: FAIL. No `socket_streams_total` line, no `socket stream` debug line, and the snapshot lacks `SOCKET_METRIC_KEY_STREAMS` / `observeStream`.

- [ ] **Step 3: Implement the metric and the debug line**

In `packages/http-socket/src/metrics.ts`, replace

```ts
export const SOCKET_METRIC_KEY_CONNECTIONS = 'connections';
```

with

```ts
export const SOCKET_METRIC_KEY_CONNECTIONS = 'connections';
export const SOCKET_METRIC_KEY_STREAMS = 'streams_total';
```

replace

```ts
  { name: SOCKET_METRIC_KEY_CONNECTIONS, help: 'Open socket connections', type: 'gauge' },
];
```

with

```ts
  { name: SOCKET_METRIC_KEY_CONNECTIONS, help: 'Open socket connections', type: 'gauge' },
  { name: SOCKET_METRIC_KEY_STREAMS, help: 'Socket stream replies ended, by command and outcome ( ok or the error code )', type: 'counter', labelNames: ['command', 'code'] },
];
```

and append after `observeCommand`:

```ts
export function observeStream(command: string, code: string): void {
  const metrics = socketMetrics();
  if (!metrics) {
    return;
  }

  (metrics[SOCKET_METRIC_KEY_STREAMS] as Counter<string>).inc({ command, code });
}
```

In `packages/http-socket/src/dispatcher.ts`, replace

```ts
import { SOCKET_UNKNOWN_COMMAND, observeCommand } from './metrics.js';
```

with

```ts
import { SOCKET_UNKNOWN_COMMAND, observeCommand, observeStream } from './metrics.js';
```

replace

```ts
import { ServerStream } from './stream.js';
```

with

```ts
import { ServerStream, StreamOutcome } from './stream.js';
```

and replace the whole `runStream` method from Task 3 with:

```ts
  protected runStream(ctx: SocketCommandContext, stream: ServerStream): void {
    const runtime = ctx.runtime;
    const started = performance.now();

    void stream.run().then((outcome) => {
      runtime.streams--;
      if (runtime.running.get(ctx.request.id) === ctx) {
        runtime.running.delete(ctx.request.id);
      }
      this.streamEnded(ctx, stream, outcome, performance.now() - started);
    });
  }

  protected streamEnded(ctx: SocketCommandContext, stream: ServerStream, outcome: StreamOutcome, ms: number): void {
    // observability must never break the stream bookkeeping above
    try {
      this.Log.debug(`socket stream ${ctx.request.name} ${outcome} ${stream.sent} chunks ${Math.round(ms)}ms connection ${ctx.connection.id}`);
      observeStream(ctx.handler?.fullName ?? SOCKET_UNKNOWN_COMMAND, outcome);
    } catch {
      // swallowed on purpose
    }
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npx ts-mocha -p tsconfig.json test/stream-observability.test.ts test/exports.test.ts test/observability.test.ts`
Expected: PASS, 0 failing.

- [ ] **Step 5: Release notes**

In `packages/http-socket/RELEASE_NOTES.md`:

1. Replace the line `### Configuration` (the heading under `## New`) with:

```md
### Stream replies (W4)

- A command handler that returns an async iterable (an `async *` method) answers with a stream reply. The ack is `{ id, ok: true, stream: true }`. Then come `chunk { id, seq, data }` frames numbered from 0, and finally `end { id, seq }` (`seq` = the number of chunks) or `fail { id, error }`. An `undefined` item is sent as `null`. Binary parts travel as attachments, as in commands.
- Flow control is by credit. The request carries `credits`, the client's window. The server asks the generator for the next item only while it holds credit, so a slow consumer slows the producer. Finding the end of a stream also takes one unit of credit. The client grants more with `credit { id, credits }` as it reads.
- `cancel { id }`, a disconnect and shutdown abort the handler's `AbortSignal` (`cancelled` / `unavailable`) and run the generator's `finally`. A stream that gets no credit for `streams.stallTimeoutMs` fails with `deadline_exceeded`.
- The generator runs inside the call's AsyncLocalStorage store for every item, so `AuthzService.current()` is the connection principal there too.
- A stream command called without `credits` (a plain `client.command()`) is answered `failed_precondition`, and its generator never starts. W1 answered stream handlers with `unimplemented`.
- `credits` above `streams.maxCredits`, at the request or by a later grant, fails with `invalid_argument` and `details { limit }`. More than `streams.maxPerConnection` open streams on one connection answers `resource_exhausted` with `retryAfterMs: 100`. An open stream holds no `maxInFlightPerConnection` slot.
- `deadline` and `@Command({ timeoutMs })` bound the time until the stream reply only. A stream handler cannot be `ordered`: the registry refuses an `ordered` async generator at startup with `InvalidOperation`, and an `ordered` handler returning another async iterable is answered `failed_precondition`.
- An open stream keeps its request id in flight until its `end` or `fail` frame.
- Metrics: `socket_streams_total{command, code}` counts ended streams by outcome (`ok` or the error code). One debug line per stream: `socket stream <name> <outcome> <n> chunks <ms>ms connection <id>`.

### Configuration
```

2. Replace the line

```md
- `http.socket.hooks.connectTimeoutMs` (default `10_000`): a connect hook still running after it is logged and commands stop waiting for it, so a disconnect hook may start while the connect hook is still running.
```

with

```md
- `http.socket.hooks.connectTimeoutMs` (default `10_000`): a connect hook still running after it is logged and commands stop waiting for it, so a disconnect hook may start while the connect hook is still running.
- `http.socket.streams` (default `{ maxCredits: 64, maxPerConnection: 8, stallTimeoutMs: 60_000 }`): the largest window a client may grant one stream, the open streams per connection, and how long a stream may wait for credit.
```

3. Replace the line `- `ordering.abortGraceMs` is not a positive number.` with:

```md
- `ordering.abortGraceMs` is not a positive number;
- `streams.maxCredits` or `streams.maxPerConnection` is not an integer above 0;
- `streams.stallTimeoutMs` is not an integer within 1 and 2^31-1.
```

- [ ] **Step 6: Run the whole server suite, build, commit**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket && npm test`
Expected: 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0.

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/src/metrics.ts packages/http-socket/src/dispatcher.ts packages/http-socket/test/stream-observability.test.ts packages/http-socket/test/exports.test.ts packages/http-socket/RELEASE_NOTES.md && \
git commit -m "feat(http-socket): stream metrics and debug line; release notes for stream replies"
```

---

### Task 5: Client streams: `StreamDispatcher` and `ClientStream`

**Files:**
- Create: `packages/http-socket-client/src/streams.ts`
- Modify: `packages/http-socket-client/test/support/stub-server.ts` (`RawReply` also receives the socket)
- Create: `packages/http-socket-client/test/support/stream-stub.ts`, `packages/http-socket-client/test/support/streams.ts`
- Test: `packages/http-socket-client/test/streams.test.ts`, `packages/http-socket-client/test/stream-lifecycle.test.ts`

**Interfaces:**
- Consumes:
  - W2 `Connection`: `state`, `connected`, `events.on('state', (state, previous) => …)`, `request(event, data, onReply): boolean`, `send(event, ...args): boolean`, `listen(event, handler)`.
  - W2 `CommandDispatcher.nextId()`, the single id space.
  - W2 `assertTimeoutMs(name, value)` (`src/timeout.ts`).
  - Task 1's `isChunk`, `isStreamEnd`, `isStreamFail`, `CommandRequest.credits`.
- Produces:
  - `DEFAULT_STREAM_CREDITS = 8`
  - `interface StreamOptions extends CommandOptions { credits?: number }`
  - `class StreamDispatcher { constructor(connection: Connection, nextId: () => string, defaultTimeoutMs: number); stream<T>(name: string, payload?: unknown, options?: StreamOptions): ClientStream<T> }`
  - `class ClientStream<T> implements AsyncIterableIterator<T> { next(); return(); [Symbol.asyncIterator]() }`. It starts lazily on the first `next()`, and `return()` sends `cancel`.
  - Rejections are common's `SocketException`, except bad options, which reject with a `RangeError`.
  - Messages:
    - `unavailable`: `'the client is closed'` (not retryable), `'the client is offline'`, `'the client stayed offline until the timeout'`, `'the connection dropped during the stream'`
    - `deadline_exceeded`: `'no reply before the timeout'`, `'no stream frame before the timeout'`
    - `cancelled`: `'the stream was cancelled'`
    - `failed_precondition`: `'the command does not reply with a stream; use command()'`
    - `internal`: `'malformed reply'`, `'stream frames arrived out of order'`, `'the server sent more chunks than it had credit for'`

- [ ] **Step 1: Let the stub server's raw replies use the socket**

In `packages/http-socket-client/test/support/stub-server.ts`, replace

```ts
export type RawReply = (request: CommandRequest) => unknown;
```

with

```ts
export type RawReply = (request: CommandRequest, socket: Socket) => unknown;
```

and replace

```ts
    if (raw) return raw(request);
```

with

```ts
    if (raw) return raw(request, socket);
```

- [ ] **Step 2: Write the stub stream server and the test helpers**

Create `packages/http-socket-client/test/support/stream-stub.ts`:

```ts
import type { Socket } from 'socket.io';
import { WIRE_EVENTS, isCancelFrame, isSocketError, type Chunk, type CommandReply, type CommandRequest, type StreamCredit, type StreamEnd, type StreamFail } from '@spinajs/http-socket-common';
import type { StubServer } from './stub-server.js';

export type StubStreamSource = (payload: any, request: CommandRequest) => Iterable<unknown> | AsyncIterable<unknown>;

export interface StubStreamLog {
  readonly request: CommandRequest;
  /** credit frames received, in order */
  readonly credits: number[];
  sent: number;
  cancelled: boolean;
}

/**
 * Serves `name` as a stream reply the way the W4 server does: the ack `{ stream: true }`, then one
 * chunk per unit of credit ( the source is asked for an item only with credit in hand ), then `end`,
 * or `fail` when the source throws a SocketError.
 */
export function serveStream(server: StubServer, name: string, source: StubStreamSource): StubStreamLog[] {
  const logs: StubStreamLog[] = [];

  server.rawReplies.set(name, (request, socket) => {
    const log: StubStreamLog = { request, credits: [], sent: 0, cancelled: false };
    logs.push(log);
    // after the ack, which the stub writes once this function has returned
    setTimeout(() => void pump(socket, request, source, log), 0);
    const reply: CommandReply = { id: request.id, ok: true, stream: true };
    return reply;
  });

  return logs;
}

async function pump(socket: Socket, request: CommandRequest, source: StubStreamSource, log: StubStreamLog): Promise<void> {
  let credit = request.credits ?? 0;
  let wake: (() => void) | null = null;
  const onCredit = (frame: StreamCredit) => {
    if (frame?.id !== request.id) return;
    log.credits.push(frame.credits);
    credit += frame.credits;
    wake?.();
  };
  const onCancel = (frame: unknown) => {
    if (!isCancelFrame(frame) || frame.id !== request.id) return;
    log.cancelled = true;
    wake?.();
  };
  const onDisconnect = () => wake?.();
  socket.on(WIRE_EVENTS.credit, onCredit);
  socket.on(WIRE_EVENTS.cancel, onCancel);
  socket.on('disconnect', onDisconnect);

  try {
    const items = source(request.payload, request);
    const iterator = (Symbol.asyncIterator in items ? (items as AsyncIterable<unknown>)[Symbol.asyncIterator]() : (items as Iterable<unknown>)[Symbol.iterator]()) as AsyncIterator<unknown> | Iterator<unknown>;

    for (;;) {
      while (credit === 0 && !log.cancelled && socket.connected) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      if (log.cancelled || !socket.connected) return;

      const step = await iterator.next();
      if (log.cancelled || !socket.connected) return;
      if (step.done) {
        const end: StreamEnd = { id: request.id, seq: log.sent };
        socket.emit(WIRE_EVENTS.end, end);
        return;
      }

      const chunk: Chunk = { id: request.id, seq: log.sent, data: step.value };
      socket.emit(WIRE_EVENTS.chunk, chunk);
      log.sent++;
      credit--;
    }
  } catch (error) {
    const fail: StreamFail = { id: request.id, error: isSocketError(error) ? error : { code: 'internal', message: 'stream source failed', retryable: false } };
    socket.emit(WIRE_EVENTS.fail, fail);
  } finally {
    socket.off(WIRE_EVENTS.credit, onCredit);
    socket.off(WIRE_EVENTS.cancel, onCancel);
    socket.off('disconnect', onDisconnect);
  }
}

export function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

export function* endless(): Generator<number> {
  for (let i = 0; ; i++) yield i;
}
```

Create `packages/http-socket-client/test/support/streams.ts`:

```ts
import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { StreamDispatcher } from '../../src/streams.js';
import { makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { waitForState } from './wait.js';

/** Streams on a connection, with ids from a CommandDispatcher as SocketClient wires them. */
export function streamsOn(connection: Connection, timeoutMs = 1000): StreamDispatcher {
  const commands = new CommandDispatcher(connection, timeoutMs);
  return new StreamDispatcher(connection, () => commands.nextId(), timeoutMs);
}

export async function onlineStreams(server: StubServer, timeoutMs = 1000): Promise<{ connection: Connection; streams: StreamDispatcher }> {
  const connection = makeConnection(server);
  const streams = streamsOn(connection, timeoutMs);
  connection.connect();
  await waitForState(statefulConnection(connection), 'online');
  return { connection, streams };
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** Reads until the stream fails; resolves with the items read and the rejection. */
export async function readUntilFailure<T>(items: AsyncIterable<T>): Promise<{ items: T[]; error: unknown }> {
  const out: T[] = [];
  try {
    for await (const item of items) out.push(item);
  } catch (error) {
    return { items: out, error };
  }
  throw new Error('expected the stream to fail');
}
```

- [ ] **Step 3: Write the failing flow-control and protocol tests**

Create `packages/http-socket-client/test/streams.test.ts`:

```ts
import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { SocketException, WIRE_EVENTS, type CommandReply } from '@spinajs/http-socket-common';
import { closeAll } from './support/cleanup.js';
import { rejectionOf } from './support/commands.js';
import { endless, range, serveStream } from './support/stream-stub.js';
import { collect, onlineStreams, readUntilFailure } from './support/streams.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

chai.use(chaiAsPromised);

const streamReply = (id: string): CommandReply => ({ id, ok: true, stream: true });

describe('client stream replies', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('sends nothing before the first next(), then the request with the credit window, and yields every item in order', async () => {
    const logs = serveStream(server, 'n.list', () => [0, 1, 2, 3, 4]);
    const { streams } = await onlineStreams(server);

    const items = streams.stream<number>('n.list', { q: 'x' }, { traceparent: '00-abc-def-01' });
    await sleep(30);
    expect(server.requests).to.have.length(0);

    expect(await collect(items)).to.deep.equal([0, 1, 2, 3, 4]);

    const [request] = server.requests;
    expect(request).to.include({ name: 'n.list', credits: 8, traceparent: '00-abc-def-01' });
    expect(request.payload).to.deep.equal({ q: 'x' });
    expect(request.deadline).to.be.within(1, 1000);
    expect(logs[0].sent).to.equal(5);
  });

  it('never has more than `credits` chunks in flight or buffered ahead of a slow consumer ( spec §7 )', async () => {
    const logs = serveStream(server, 'n.many', () => range(20));
    const { streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.many', null, { credits: 4 });

    expect(await items.next()).to.deep.equal({ value: 0, done: false });
    await sleep(50);
    expect(logs[0].sent).to.equal(4);
    expect(logs[0].credits).to.deep.equal([]);

    expect(await items.next()).to.deep.equal({ value: 1, done: false });
    await sleep(50);
    // half the window is free: one grant of 2
    expect(logs[0].credits).to.deep.equal([2]);
    expect(logs[0].sent).to.equal(6);

    let consumed = 2;
    for await (const item of items) {
      expect(item).to.equal(consumed);
      consumed++;
      expect(logs[0].sent - consumed).to.be.at.most(4);
    }
    expect(consumed).to.equal(20);
  });

  it('break sends cancel for the stream, and the server source stops', async () => {
    const logs = serveStream(server, 'n.endless', () => endless());
    const { streams } = await onlineStreams(server);

    for await (const item of streams.stream<number>('n.endless', null, { credits: 2 })) {
      if (item === 2) break;
    }

    await until(() => logs[0].cancelled);
    expect(server.cancels).to.deep.equal([logs[0].request.id]);
  });

  it('delivers the chunks before a server failure, then rejects with its SocketError', async () => {
    serveStream(server, 'n.broken', async function* () {
      yield 1;
      yield 2;
      throw { code: 'not_found', message: 'gone', retryable: false };
    });
    const { streams } = await onlineStreams(server);

    const { items, error } = await readUntilFailure(streams.stream<number>('n.broken'));

    expect(items).to.deep.equal([1, 2]);
    expect(error).to.be.instanceOf(SocketException);
    expect((error as SocketException).toWire()).to.deep.equal({ code: 'not_found', message: 'gone', retryable: false });
  });

  it('rejects an error reply with its SocketError', async () => {
    server.handlers.set('n.denied', () => {
      throw { code: 'forbidden', message: 'no', retryable: false };
    });
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.denied').next());
    expect(error.toWire()).to.deep.equal({ code: 'forbidden', message: 'no', retryable: false });
  });

  it('rejects a plain result with failed_precondition', async () => {
    server.handlers.set('n.plain', () => 42);
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.plain').next());
    expect(error.toWire()).to.deep.equal({ code: 'failed_precondition', message: 'the command does not reply with a stream; use command()', retryable: false });
  });

  it('fails frames out of order with internal and cancels the stream', async () => {
    server.rawReplies.set('n.skip', (request, socket) => {
      setTimeout(() => socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq: 1, data: 'b' }), 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.skip').next());
    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'stream frames arrived out of order', retryable: false });
    await until(() => server.cancels.length === 1);
  });

  it('fails an end frame whose count differs from the chunks received', async () => {
    server.rawReplies.set('n.short', (request, socket) => {
      setTimeout(() => {
        socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq: 0, data: 'a' });
        socket.emit(WIRE_EVENTS.end, { id: request.id, seq: 2 });
      }, 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);
    const items = streams.stream<string>('n.short');

    expect((await items.next()).value).to.equal('a');
    const error = await rejectionOf(items.next());
    expect(error.message).to.equal('stream frames arrived out of order');
  });

  it('fails a chunk beyond the granted credit with internal', async () => {
    server.rawReplies.set('n.flood', (request, socket) => {
      setTimeout(() => {
        for (let seq = 0; seq < 6; seq++) socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq, data: seq });
      }, 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.flood', null, { credits: 4 });

    expect((await items.next()).value).to.equal(0);
    await sleep(50);
    const error = await rejectionOf(items.next());
    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'the server sent more chunks than it had credit for', retryable: false });
  });

  it('rejects a malformed reply with internal', async () => {
    server.rawReplies.set('n.garbage', () => 'not a reply');
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.garbage').next());
    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'malformed reply', retryable: false });
  });

  it('ignores frames of other ids', async () => {
    server.rawReplies.set('n.noise', (request, socket) => {
      setTimeout(() => {
        socket.emit(WIRE_EVENTS.chunk, { id: 'someone-else', seq: 0, data: 'x' });
        socket.emit(WIRE_EVENTS.chunk, { id: request.id, seq: 0, data: 'mine' });
        socket.emit(WIRE_EVENTS.end, { id: request.id, seq: 1 });
      }, 10);
      return streamReply(request.id);
    });
    const { streams } = await onlineStreams(server);

    expect(await collect(streams.stream('n.noise'))).to.deep.equal(['mine']);
  });

  it('streams binary chunk parts', async () => {
    serveStream(server, 'n.bin', () => [new Uint8Array([1, 2, 3])]);
    const { streams } = await onlineStreams(server);

    const [bytes] = await collect(streams.stream<ArrayBuffer>('n.bin'));
    expect(Array.from(new Uint8Array(bytes))).to.deep.equal([1, 2, 3]);
  });

  it('rejects credits that are not a positive integer with a RangeError, sending nothing', async () => {
    const { streams } = await onlineStreams(server);

    for (const credits of [0, -1, 1.5, Number.NaN]) {
      await expect(streams.stream('n.x', null, { credits }).next()).to.be.rejectedWith(RangeError);
    }
    expect(server.requests).to.have.length(0);
  });

  it('return() before the first next() sends nothing and ends the iterator', async () => {
    const { streams } = await onlineStreams(server);
    const items = streams.stream('n.x');

    expect(await items.return()).to.deep.equal({ value: undefined, done: true });
    expect(await items.next()).to.deep.equal({ value: undefined, done: true });
    await sleep(30);
    expect(server.requests).to.have.length(0);
  });
});
```

Create `packages/http-socket-client/test/stream-lifecycle.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { rejectionOf } from './support/commands.js';
import { makeConnection } from './support/connection.js';
import { endless, serveStream } from './support/stream-stub.js';
import { collect, onlineStreams, readUntilFailure, streamsOn } from './support/streams.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

describe('client stream lifecycle', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('rejects at once with unavailable while offline ( whenOffline fail, the default )', async () => {
    const streams = streamsOn(makeConnection(server));

    const error = await rejectionOf(streams.stream('n.list').next());
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is offline', retryable: true });
  });

  it('holds the request while offline with whenOffline wait, and sends it once online', async () => {
    serveStream(server, 'n.list', () => ['a']);
    const connection = makeConnection(server);
    const streams = streamsOn(connection);

    const all = collect(streams.stream<string>('n.list', null, { whenOffline: 'wait' }));
    await sleep(30);
    expect(server.requests).to.have.length(0);

    connection.connect();
    expect(await all).to.deep.equal(['a']);
  });

  it('rejects with unavailable when still offline at the timeout', async () => {
    const streams = streamsOn(makeConnection(server));

    const error = await rejectionOf(streams.stream('n.list', null, { whenOffline: 'wait', timeoutMs: 50 }).next());
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true });
  });

  it('times out with deadline_exceeded when no reply arrives, and cancels', async () => {
    server.handlers.set('n.silent', () => new Promise(() => undefined));
    const { streams } = await onlineStreams(server);

    const error = await rejectionOf(streams.stream('n.silent', null, { timeoutMs: 80 }).next());
    expect(error.toWire()).to.deep.equal({ code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true });
    await until(() => server.cancels.length === 1);
  });

  it('times out with deadline_exceeded when the next frame does not come within timeoutMs, and cancels', async () => {
    serveStream(server, 'n.stuck', async function* () {
      yield 'first';
      await new Promise(() => undefined);
    });
    const { streams } = await onlineStreams(server, 80);
    const items = streams.stream<string>('n.stuck');

    expect((await items.next()).value).to.equal('first');
    const error = await rejectionOf(items.next());
    expect(error.toWire()).to.deep.equal({ code: 'deadline_exceeded', message: 'no stream frame before the timeout', retryable: true });
    await until(() => server.cancels.length === 1);
  });

  it('a slow consumer is not timed out: the timeout runs only while next() waits', async () => {
    serveStream(server, 'n.two', () => ['a', 'b']);
    const { streams } = await onlineStreams(server, 80);
    const items = streams.stream<string>('n.two');

    expect((await items.next()).value).to.equal('a');
    await sleep(200);
    expect((await items.next()).value).to.equal('b');
    expect((await items.next()).done).to.be.true;
  });

  it('aborting the signal rejects with cancelled, drops buffered items and cancels the stream', async () => {
    serveStream(server, 'n.endless', () => endless());
    const { streams } = await onlineStreams(server);
    const controller = new AbortController();
    const items = streams.stream<number>('n.endless', null, { signal: controller.signal, credits: 4 });

    expect((await items.next()).value).to.equal(0);
    await sleep(30);
    controller.abort();

    const error = await rejectionOf(items.next());
    expect(error.toWire()).to.deep.equal({ code: 'cancelled', message: 'the stream was cancelled', retryable: false });
    await until(() => server.cancels.length === 1);
  });

  it('rejects at once, sending nothing, when the signal is already aborted', async () => {
    const { streams } = await onlineStreams(server);
    const controller = new AbortController();
    controller.abort();

    const error = await rejectionOf(streams.stream('n.list', null, { signal: controller.signal }).next());
    expect(error.code).to.equal('cancelled');
    expect(server.requests).to.have.length(0);
  });

  it('delivers what arrived before a drop, then rejects with a retryable unavailable', async () => {
    serveStream(server, 'n.endless', () => endless());
    const { streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.endless', null, { credits: 4 });

    expect((await items.next()).value).to.equal(0);
    // chunks 1, 2 and 3 are buffered: one consumed item frees less than half the window
    await sleep(50);
    server.killConnections();
    await sleep(50);

    const { items: rest, error } = await readUntilFailure(items);
    expect(rest).to.deep.equal([1, 2, 3]);
    expect((error as { toWire(): unknown }).toWire()).to.deep.equal({ code: 'unavailable', message: 'the connection dropped during the stream', retryable: true });
  });

  it('rejects a waiting next() when the client closes', async () => {
    serveStream(server, 'n.once', async function* () {
      yield 0;
      await new Promise(() => undefined);
    });
    const { connection, streams } = await onlineStreams(server);
    const items = streams.stream<number>('n.once');

    expect((await items.next()).value).to.equal(0);
    const pending = items.next();
    connection.close();

    const error = await rejectionOf(pending);
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is closed', retryable: false });
  });

  it('rejects a new stream on a closed client', async () => {
    const { connection, streams } = await onlineStreams(server);
    connection.close();

    const error = await rejectionOf(streams.stream('n.list').next());
    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is closed', retryable: false });
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/streams.test.ts test/stream-lifecycle.test.ts`
Expected: FAIL with `Cannot find module '../../src/streams.js'`.

- [ ] **Step 5: Implement `src/streams.ts`**

Create `packages/http-socket-client/src/streams.ts`:

```ts
import { SocketException, WIRE_EVENTS, isChunk, isSocketError, isStreamEnd, isStreamFail, type CancelFrame, type Chunk, type CommandReply, type CommandRequest, type SocketError, type StreamCredit, type StreamEnd } from '@spinajs/http-socket-common';
import type { CommandOptions } from './commands.js';
import type { Connection, ConnectionState } from './connection.js';
import { assertTimeoutMs } from './timeout.js';

export interface StreamOptions extends CommandOptions {
  /**
   * Chunks the server may send ahead of the consumer: the most that are ever in flight or buffered.
   * More are granted as the consumer reads. At most the server's `http.socket.streams.maxCredits` ( 64 ).
   */
  credits?: number;
}

export const DEFAULT_STREAM_CREDITS = 8;

const CLOSED: SocketError = { code: 'unavailable', message: 'the client is closed', retryable: false };
const OFFLINE: SocketError = { code: 'unavailable', message: 'the client is offline', retryable: true };
const STAYED_OFFLINE: SocketError = { code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true };
const CONNECTION_LOST: SocketError = { code: 'unavailable', message: 'the connection dropped during the stream', retryable: true };
const NO_REPLY: SocketError = { code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true };
const NO_FRAME: SocketError = { code: 'deadline_exceeded', message: 'no stream frame before the timeout', retryable: true };
const CANCELLED: SocketError = { code: 'cancelled', message: 'the stream was cancelled', retryable: false };
const NOT_A_STREAM: SocketError = { code: 'failed_precondition', message: 'the command does not reply with a stream; use command()', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };
const OUT_OF_ORDER: SocketError = { code: 'internal', message: 'stream frames arrived out of order', retryable: false };
const OVER_CREDIT: SocketError = { code: 'internal', message: 'the server sent more chunks than it had credit for', retryable: false };

type Timer = ReturnType<typeof setTimeout>;

/** idle → (waiting →) sent → open → done; `waiting` only with whenOffline 'wait'. */
type Phase = 'idle' | 'waiting' | 'sent' | 'open' | 'done';

interface StreamHost {
  readonly connection: Connection;
  readonly defaultTimeoutMs: number;
  nextId(): string;
  hold(stream: ClientStream<unknown>): void;
  register(id: string, stream: ClientStream<unknown>): void;
  release(stream: ClientStream<unknown>): void;
}

function assertCredits(value: number): void {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError(`credits must be a positive integer, got ${value}`);
  }
}

/** Routes stream frames to their ClientStream and fails or resumes streams on connection changes. */
export class StreamDispatcher implements StreamHost {
  private readonly waiting = new Set<ClientStream<unknown>>();
  private readonly open = new Map<string, ClientStream<unknown>>();

  constructor(
    public readonly connection: Connection,
    private readonly ids: () => string,
    public readonly defaultTimeoutMs: number,
  ) {
    assertTimeoutMs('defaultTimeoutMs', defaultTimeoutMs);
    connection.listen(WIRE_EVENTS.chunk, (frame: unknown) => {
      if (isChunk(frame)) this.open.get(frame.id)?.onChunk(frame);
    });
    connection.listen(WIRE_EVENTS.end, (frame: unknown) => {
      if (isStreamEnd(frame)) this.open.get(frame.id)?.onEnd(frame);
    });
    connection.listen(WIRE_EVENTS.fail, (frame: unknown) => {
      if (isStreamFail(frame)) this.open.get(frame.id)?.onFail(frame.error);
    });
    connection.events.on('state', (state, previous) => this.onState(state, previous));
  }

  public stream<T>(name: string, payload?: unknown, options: StreamOptions = {}): ClientStream<T> {
    return new ClientStream<T>(this, name, payload, options);
  }

  public nextId(): string {
    return this.ids();
  }

  public hold(stream: ClientStream<unknown>): void {
    this.waiting.add(stream);
  }

  public register(id: string, stream: ClientStream<unknown>): void {
    this.open.set(id, stream);
  }

  public release(stream: ClientStream<unknown>): void {
    this.waiting.delete(stream);
    if (this.open.get(stream.id) === stream) this.open.delete(stream.id);
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      for (const stream of [...this.waiting, ...this.open.values()]) stream.abandon(CLOSED);
      return;
    }
    if (previous === 'online') for (const stream of [...this.open.values()]) stream.abandon(CONNECTION_LOST);
    if (state === 'online') for (const stream of [...this.waiting]) stream.transmit();
  }
}

/**
 * One stream reply as an async iterator. It starts on the first `next()`. It keeps
 * `granted − consumed ≤ credits`, so no more than `credits` chunks are ever in flight or buffered.
 */
export class ClientStream<T> implements AsyncIterableIterator<T> {
  private phase: Phase = 'idle';
  private requestId = '';
  private readonly buffer: T[] = [];
  private reader: { resolve(result: IteratorResult<T>): void; reject(error: unknown): void } | null = null;
  private failure: unknown = null;
  private received = 0;
  private granted = 0;
  private consumed = 0;
  private deadlineAt = 0;
  private timer: Timer | undefined;
  private readonly window: number;
  private readonly timeoutMs: number;
  private readonly onAbort = (): void => this.stop(CANCELLED);

  constructor(
    private readonly host: StreamHost,
    private readonly name: string,
    private readonly payload: unknown,
    private readonly options: StreamOptions,
  ) {
    this.window = options.credits ?? DEFAULT_STREAM_CREDITS;
    this.timeoutMs = options.timeoutMs ?? host.defaultTimeoutMs;
  }

  /** The request id; empty until the request is sent. */
  public get id(): string {
    return this.requestId;
  }

  public [Symbol.asyncIterator](): this {
    return this;
  }

  public next(): Promise<IteratorResult<T>> {
    if (this.phase === 'idle') this.start();
    if (this.buffer.length > 0) return Promise.resolve({ value: this.take(), done: false });
    if (this.phase === 'done') return this.failure === null ? Promise.resolve({ value: undefined, done: true }) : Promise.reject(this.failure);
    if (this.reader) return Promise.reject(new TypeError('next() called before the previous next() settled'));
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.reader = { resolve, reject };
      if (this.phase === 'open') this.arm(this.timeoutMs, NO_FRAME);
    });
  }

  /** `for await` calls it on break or throw: the server is told to stop and its generator's `finally` runs. */
  public async return(): Promise<IteratorResult<T>> {
    this.stop(null);
    return { value: undefined, done: true };
  }

  /** @internal sends the request now, or again once online for a held stream */
  public transmit(): void {
    if (this.phase !== 'idle' && this.phase !== 'waiting') return;
    this.host.release(this);
    this.requestId = this.host.nextId();
    this.granted = this.window;
    this.phase = 'sent';
    this.host.register(this.requestId, this);

    const remaining = Math.max(1, this.deadlineAt - Date.now());
    // deadline: relative, so client/server clock skew cannot expire it; it bounds the reply only
    const request: CommandRequest = { id: this.requestId, name: this.name, payload: this.payload, credits: this.window, deadline: remaining };
    if (this.options.traceparent !== undefined) request.traceparent = this.options.traceparent;

    this.arm(remaining, NO_REPLY);
    const sent = this.host.connection.request<CommandReply>(WIRE_EVENTS.command, request, (reply) => this.onReply(reply));
    if (!sent) this.finish(CONNECTION_LOST);
  }

  /** @internal */
  public onChunk(frame: Chunk): void {
    if (this.phase !== 'sent' && this.phase !== 'open') return;
    if (frame.seq !== this.received) return this.stop(OUT_OF_ORDER);
    if (this.received >= this.granted) return this.stop(OVER_CREDIT);
    this.received++;

    const value = frame.data as T;
    const reader = this.reader;
    if (!reader) {
      this.buffer.push(value);
      return;
    }
    this.reader = null;
    this.disarm();
    this.consumed++;
    this.replenish();
    reader.resolve({ value, done: false });
  }

  /** @internal */
  public onEnd(frame: StreamEnd): void {
    if (this.phase !== 'sent' && this.phase !== 'open') return;
    if (frame.seq !== this.received) return this.stop(OUT_OF_ORDER);
    this.finish(null);
  }

  /** @internal the chunks received before the failure are still delivered */
  public onFail(error: SocketError): void {
    if (this.phase !== 'sent' && this.phase !== 'open') return;
    this.finish(error);
  }

  /** @internal the connection dropped or the client closed; the chunks received are still delivered */
  public abandon(error: SocketError): void {
    this.finish(error);
  }

  private start(): void {
    try {
      assertTimeoutMs('timeoutMs', this.timeoutMs);
      assertCredits(this.window);
    } catch (error) {
      this.phase = 'done';
      this.failure = error;
      return;
    }

    const connection = this.host.connection;
    if (connection.state === 'closed') return this.finish(CLOSED);
    if (this.options.signal?.aborted) return this.finish(CANCELLED);
    if (!connection.connected && (this.options.whenOffline ?? 'fail') === 'fail') return this.finish(OFFLINE);

    this.deadlineAt = Date.now() + this.timeoutMs;
    this.options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (connection.connected) return this.transmit();

    this.phase = 'waiting';
    this.host.hold(this);
    this.arm(this.timeoutMs, STAYED_OFFLINE);
  }

  private onReply(reply: CommandReply): void {
    if (this.phase !== 'sent') return;
    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') return this.stop(MALFORMED_REPLY);
    if (!reply.ok) return this.finish(isSocketError(reply.error) ? reply.error : MALFORMED_REPLY);
    if (!('stream' in reply) || reply.stream !== true) return this.finish(NOT_A_STREAM);

    this.phase = 'open';
    this.disarm();
    if (this.reader) this.arm(this.timeoutMs, NO_FRAME);
  }

  private take(): T {
    const value = this.buffer.shift() as T;
    this.consumed++;
    this.replenish();
    return value;
  }

  /** Grants in batches of at least half the window, so a fast consumer does not send one frame per chunk. */
  private replenish(): void {
    if (this.phase !== 'open') return;
    const free = this.window - (this.granted - this.consumed);
    if (free < Math.max(1, Math.floor(this.window / 2))) return;
    const credit: StreamCredit = { id: this.requestId, credits: free };
    if (this.host.connection.send(WIRE_EVENTS.credit, credit)) this.granted += free;
  }

  /** Ends the stream from this side: buffered items are dropped and the server is told to stop. */
  private stop(error: SocketError | null): void {
    this.buffer.length = 0;
    if (this.phase === 'sent' || this.phase === 'open') {
      const cancel: CancelFrame = { id: this.requestId };
      this.host.connection.send(WIRE_EVENTS.cancel, cancel);
    }
    this.finish(error);
  }

  private finish(error: SocketError | null): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.disarm();
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.host.release(this);
    if (error !== null) this.failure = SocketException.fromWire(error);

    // a waiting reader means the buffer is empty
    const reader = this.reader;
    if (!reader) return;
    this.reader = null;
    if (this.failure === null) reader.resolve({ value: undefined, done: true });
    else reader.reject(this.failure);
  }

  private arm(ms: number, error: SocketError): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stop(error);
    }, ms);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/streams.test.ts test/stream-lifecycle.test.ts`
Expected: PASS, 25 passing.

- [ ] **Step 7: Type-check and run the whole client suite**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npm run typecheck && npm test`
Expected: the typecheck exits 0, and the suite shows 0 failing. `test/isomorphic.test.ts` passes: `streams.ts` uses no Node globals.

- [ ] **Step 8: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/streams.ts packages/http-socket-client/test/support/stub-server.ts packages/http-socket-client/test/support/stream-stub.ts packages/http-socket-client/test/support/streams.ts packages/http-socket-client/test/streams.test.ts packages/http-socket-client/test/stream-lifecycle.test.ts && \
git commit -m "feat(http-socket-client): stream replies as async iterators with a credit window"
```

---

### Task 6: `SocketClient.stream()`, typed streams, exports

**Files:**
- Modify: `packages/http-socket-client/src/client.ts` (import, `streams` field, constructor, `stream()`)
- Modify: `packages/http-socket-client/src/contract.ts` (`TypedSocketClient.stream`)
- Modify: `packages/http-socket-client/src/index.ts`
- Test: `packages/http-socket-client/test/client-stream.test.ts`
- Modify: `packages/http-socket-client/test/index.test.ts`

**Interfaces:**
- Consumes: Task 5's `StreamDispatcher`, `StreamOptions` and `DEFAULT_STREAM_CREDITS`.
- Produces:
  - `SocketClient.stream<T = unknown>(name: string, payload?: unknown, options?: StreamOptions): AsyncIterableIterator<T>`
  - `TypedSocketClient<C>.stream<N>(name: N, payload: CommandPayload<C, N>, options?: StreamOptions): AsyncIterableIterator<StreamItem<C, N>>`
  - Public exports: `DEFAULT_STREAM_CREDITS` and type `StreamOptions`. `StreamDispatcher` and `ClientStream` stay internal.

- [ ] **Step 1: Write the failing tests**

Create `packages/http-socket-client/test/client-stream.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { serveStream } from './support/stream-stub.js';
import { collect } from './support/streams.js';
import { StubServer } from './support/stub-server.js';
import { waitForState } from './support/wait.js';

describe('SocketClient.stream', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('yields the items of a stream reply', async () => {
    serveStream(server, 'n.list', () => [1, 2, 3]);
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');

    expect(await collect(client.stream<number>('n.list', null, { credits: 2 }))).to.deep.equal([1, 2, 3]);
    expect(server.requests[0].credits).to.equal(2);
  });

  it('takes stream ids from the command id space', async () => {
    serveStream(server, 'n.list', () => [1]);
    server.handlers.set('ping', () => 'pong');
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');

    await client.command('ping');
    await collect(client.stream('n.list'));
    await client.command('ping');

    expect(new Set(server.requests.map((r) => r.id)).size).to.equal(3);
  });

  it('rejects open streams when the client closes', async () => {
    serveStream(server, 'n.once', async function* () {
      yield 1;
      await new Promise(() => undefined);
    });
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const items = client.stream<number>('n.once');
    await items.next();

    const pending = items.next();
    client.close();

    await pending.then(
      () => expect.fail('expected a rejection'),
      (error: { code: string; retryable: boolean }) => expect(error).to.include({ code: 'unavailable', retryable: false }),
    );
  });
});
```

In `packages/http-socket-client/test/index.test.ts`:

1. Replace

```ts
    for (const name of ['SocketClient', 'LIFECYCLE_EVENTS', 'ReconnectPolicy', 'DEFAULT_RECONNECT', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_CONNECT_TIMEOUT_MS', 'MAX_SERVER_HINT_MS', 'SocketException', 'isSocketError', 'WIRE_EVENTS', 'SYSTEM_EVENTS', 'defineContract', 'PROTOCOL_VERSION']) {
```

with

```ts
    for (const name of ['SocketClient', 'LIFECYCLE_EVENTS', 'ReconnectPolicy', 'DEFAULT_RECONNECT', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_CONNECT_TIMEOUT_MS', 'DEFAULT_STREAM_CREDITS', 'MAX_SERVER_HINT_MS', 'SocketException', 'isSocketError', 'isChunk', 'WIRE_EVENTS', 'SYSTEM_EVENTS', 'defineContract', 'PROTOCOL_VERSION']) {
```

2. Replace

```ts
    for (const name of ['Connection', 'CommandDispatcher', 'Emitter', 'randomId']) {
```

with

```ts
    for (const name of ['Connection', 'CommandDispatcher', 'Emitter', 'randomId', 'StreamDispatcher', 'ClientStream']) {
```

3. Replace

```ts
    expect(api.DEFAULT_TIMEOUT_MS).to.equal(15_000);
```

with

```ts
    expect(api.DEFAULT_TIMEOUT_MS).to.equal(15_000);
    expect(api.DEFAULT_STREAM_CREDITS).to.equal(8);
```

4. Replace

```ts
  const items: AsyncIterable<number> = api.stream('n.list', { q: 'x' });
```

with

```ts
  const items: AsyncIterable<number> = api.stream('n.list', { q: 'x' });
  const iterator: AsyncIterableIterator<number> = api.stream('n.list', { q: 'x' }, { credits: 4, timeoutMs: 1000 });
  const options: StreamOptions = { credits: 16, whenOffline: 'wait' };
  void [iterator, options];
```

and replace the type import line

```ts
import type { ClientLifecycleEvents, StreamItem, TypedSocketClient } from '../src/index.js';
```

with

```ts
import type { ClientLifecycleEvents, StreamItem, StreamOptions, TypedSocketClient } from '../src/index.js';
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/client-stream.test.ts test/index.test.ts`
Expected: FAIL. `stream()` still rejects with `unimplemented`, and `DEFAULT_STREAM_CREDITS` is not exported.

- [ ] **Step 3: Wire the client**

In `packages/http-socket-client/src/client.ts`, replace

```ts
import type { ReconnectOptions } from './reconnect.js';
```

with

```ts
import type { ReconnectOptions } from './reconnect.js';
import { StreamDispatcher, type StreamOptions } from './streams.js';
```

replace

```ts
  private readonly commands: CommandDispatcher;
```

with

```ts
  private readonly commands: CommandDispatcher;
  private readonly streams: StreamDispatcher;
```

replace

```ts
    this.commands = new CommandDispatcher(this.connection, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
```

with

```ts
    this.commands = new CommandDispatcher(this.connection, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.streams = new StreamDispatcher(this.connection, () => this.commands.nextId(), options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
```

and replace the whole reserved `stream()` method

```ts
  /** Reserved: stream replies arrive with credit-based flow control. */
  public stream<T = unknown>(name: string, _payload?: unknown, _options?: CommandOptions): AsyncIterable<T> {
    const error = new SocketException('unimplemented', `stream() is not available yet (${name})`);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(error),
      }),
    };
  }
```

with

```ts
  /**
   * A stream reply as an async iterator. The request goes out on the first `next()`; at most
   * `credits` chunks are in flight or buffered; `break` cancels it on the server.
   */
  public stream<T = unknown>(name: string, payload?: unknown, options?: StreamOptions): AsyncIterableIterator<T> {
    return this.streams.stream<T>(name, payload, options);
  }
```

In `packages/http-socket-client/src/contract.ts`, replace

```ts
import type { CommandOptions } from './commands.js';
```

with

```ts
import type { CommandOptions } from './commands.js';
import type { StreamOptions } from './streams.js';
```

and replace

```ts
  stream<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: CommandOptions): AsyncIterable<StreamItem<C, N>>;
```

with

```ts
  stream<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: StreamOptions): AsyncIterableIterator<StreamItem<C, N>>;
```

In `packages/http-socket-client/src/index.ts`, replace

```ts
export type { StreamItem, TypedSocketClient } from './contract.js';
```

with

```ts
export type { StreamItem, TypedSocketClient } from './contract.js';
export { DEFAULT_STREAM_CREDITS } from './streams.js';
export type { StreamOptions } from './streams.js';
```

`SocketException` (used by `durable()`) and `CommandOptions` (used by `command()`) stay imported in `client.ts`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npx ts-mocha -p tsconfig.json test/client-stream.test.ts test/index.test.ts`
Expected: PASS, 0 failing.

- [ ] **Step 5: Type-check, run the whole client suite, build**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-client && npm run typecheck && npm test`
Expected: the typecheck exits 0, and the suite shows 0 failing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-client/tsconfig.mjs.json packages/http-socket-client/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-client/src/client.ts packages/http-socket-client/src/contract.ts packages/http-socket-client/src/index.ts packages/http-socket-client/test/client-stream.test.ts packages/http-socket-client/test/index.test.ts && \
git commit -m "feat(http-socket-client): SocketClient.stream() and typed stream items"
```

---

### Task 7: Example app `@spinajs/http-socket-example`

A small notes server and its client. It covers the editor spec's needs (§6.1–§6.2) end to end with the real server and the real client:
- a typed contract shared by both sides
- a command that joins a room, and a room push
- a snapshot stream with credits that resumes from `fromChunk` after a dropped connection
- binary `blob.put` / `blob.get`
- a refused handshake

**Files:**
- Create: `packages/http-socket-example/package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `.mocharc.json`, `.gitignore`, `README.md`
- Create: `packages/http-socket-example/src/contract.ts`, `src/store.ts`, `src/auth.ts`, `src/notes.socket.ts`, `src/server.ts`, `src/client.ts`, `src/main.ts`
- Test: `packages/http-socket-example/test/example.test.ts`
- Modify: `tsconfig.build.json` (one line after the `http-socket` line)

**Interfaces:**
- Consumes:
  - Server: `BaseSocketController`, `SocketController`, `Command`, `Payload`, `Connection`, `Signal`, `SocketConnection`, `SocketHub`, `SocketHttpHost`, `SocketServer`, `SocketPrincipalSource`, `ISocketHandshake` (`@spinajs/http-socket`).
  - Client: `SocketClient`, `TypedSocketClient`, `SocketException`, `SocketClientOptions`, `SocketError` (`@spinajs/http-socket-client`); `defineContract` (common).
  - Task 3/6 stream replies.
- Produces (example-only API, used by its tests and README):
  - `NotesContract`, `notesContract`, `SnapshotFrame`, `NoteEntity`, `Bytes`
  - `startNotesServer(options?: INotesServerOptions): Promise<INotesServer>`, where `INotesServer` is `{ url; path; server: SocketServer; store: NotesStore; close() }`
  - `connectNotes(url, path, token, options?): NotesClient`
  - `loadSnapshot(notes, docId, options?): Promise<ISnapshot>`
  - `toBytes(data: Bytes): Uint8Array`

- [ ] **Step 1: Scaffold the package**

Create `packages/http-socket-example/package.json`:

```json
{
  "name": "@spinajs/http-socket-example",
  "version": "3.0.0-alpha.0",
  "private": true,
  "description": "Example app for the spinajs WebSocket layer: a notes server with commands, rooms, a resumable snapshot stream and binary blobs, and its client",
  "type": "module",
  "main": "lib/mjs/main.js",
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "compile": "tsc -b tsconfig.mjs.json",
    "start": "node lib/mjs/main.js",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts"
  },
  "license": "MIT",
  "dependencies": {
    "@spinajs/authz": "3.0.0-alpha.0",
    "@spinajs/configuration": "2.0.548",
    "@spinajs/di": "2.0.548",
    "@spinajs/exceptions": "2.0.548",
    "@spinajs/http-socket": "2.0.548",
    "@spinajs/http-socket-client": "3.0.0-alpha.0",
    "@spinajs/http-socket-common": "3.0.0-alpha.0",
    "@spinajs/log": "2.0.548"
  }
}
```

If `packages/di/package.json` carries another version than `2.0.548` when this task starts, use that version for the four `2.0.548` pins.

Create `packages/http-socket-example/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

Create `packages/http-socket-example/tsconfig.mjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../http-socket/tsconfig.mjs.json" },
    { "path": "../http-socket-client/tsconfig.mjs.json" },
    { "path": "../http-socket-common/tsconfig.mjs.json" }
  ]
}
```

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && cp packages/http-socket-client/.mocharc.json packages/http-socket-example/.mocharc.json && cp packages/http-socket-client/.gitignore packages/http-socket-example/.gitignore`
Expected: exits 0. The `.mocharc.json` has no `spec` entry, so a file named on the command line runs alone.

In `tsconfig.build.json`, replace

```json
    { "path": "packages/http-socket/tsconfig.mjs.json"},
```

with

```json
    { "path": "packages/http-socket/tsconfig.mjs.json"},
    { "path": "packages/http-socket-example/tsconfig.mjs.json" },
```

The example has no cjs build, so `tsconfig.build.cjs.json` stays unchanged.

- [ ] **Step 2: Write the failing end-to-end tests**

Create `packages/http-socket-example/test/example.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { SocketException, type SocketError } from '@spinajs/http-socket-client';
import { connectNotes, loadSnapshot, toBytes, type NotesClient } from '../src/client.js';
import type { NotesContract } from '../src/contract.js';
import { startNotesServer, type INotesServer } from '../src/server.js';

const FAST_RECONNECT = { minMs: 20, maxMs: 100, jitter: 0 };

function online(notes: NotesClient): Promise<void> {
  if (notes.state === 'online') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const off = notes.on('state', (state) => {
      if (state === 'online') {
        off();
        resolve();
      }
    });
  });
}

/** A network drop: engine.io connections close without a socket.io DISCONNECT. */
function killConnections(server: INotesServer): void {
  for (const socket of server.server.Io?.sockets.sockets.values() ?? []) {
    socket.conn.close();
  }
}

describe('notes example ( server and client end to end )', function () {
  this.timeout(20000);

  let server: INotesServer;
  const clients: NotesClient[] = [];

  const connect = (token: string): NotesClient => {
    const notes = connectNotes(server.url, server.path, token, { reconnect: FAST_RECONNECT });
    clients.push(notes);
    return notes;
  };

  beforeEach(async () => {
    server = await startNotesServer();
  });

  afterEach(async () => {
    clients.splice(0).forEach((notes) => notes.close());
    await server.close();
  });

  it('refuses a handshake without a known token ( auth.required )', async () => {
    const notes = connect('nobody');

    const error = await new Promise<SocketError>((resolve) => notes.on('auth_required', resolve));
    expect(error).to.deep.include({ code: 'unauthenticated', message: 'authentication required' });
  });

  it('opens a document as the signed-in user, and validates the payload', async () => {
    const notes = connect('alice-token');
    await online(notes);

    expect(await notes.command('notes.open', { docId: 'doc-1' })).to.deep.equal({ docId: 'doc-1', version: 1, chunks: 20, openedBy: 'alice' });

    const refused = await notes.command('notes.open', { docId: '' }).then(
      () => null,
      (error: SocketException) => error,
    );
    expect(refused?.code).to.equal('invalid_argument');
  });

  it('streams a whole snapshot with a small credit window', async () => {
    const notes = connect('alice-token');
    await online(notes);

    const snapshot = await loadSnapshot(notes, 'doc-1', { credits: 4 });

    expect(snapshot.version).to.equal(1);
    expect(snapshot.entities.map((e) => e.id)).to.deep.equal(Array.from({ length: 100 }, (_, i) => `doc-1-${i}`));
    expect(snapshot.attempts).to.equal(1);
    expect(server.store.snapshotStarts).to.deep.equal([0]);
  });

  it('resumes a snapshot from the first missing chunk after the connection drops', async () => {
    const notes = connect('alice-token');
    await online(notes);

    let dropped = false;
    const snapshot = await loadSnapshot(notes, 'doc-1', {
      credits: 2,
      onChunk: (index) => {
        if (index === 5 && !dropped) {
          dropped = true;
          killConnections(server);
        }
      },
    });

    expect(snapshot.entities.map((e) => e.id)).to.deep.equal(Array.from({ length: 100 }, (_, i) => `doc-1-${i}`));
    expect(snapshot.attempts).to.equal(2);
    expect(server.store.snapshotStarts).to.have.length(2);
    expect(server.store.snapshotStarts[0]).to.equal(0);
    // the chunks received before the drop were applied, so the second stream starts after them
    expect(server.store.snapshotStarts[1]).to.be.greaterThan(5);
  });

  it('pushes an edit to the clients in the document room', async () => {
    const alice = connect('alice-token');
    const bob = connect('bob-token');
    await Promise.all([online(alice), online(bob)]);
    await alice.command('notes.open', { docId: 'doc-2' });
    await bob.command('notes.open', { docId: 'doc-2' });

    const seen = new Promise<NotesContract['events']['notes.changed']>((resolve) => bob.once('notes.changed', resolve));
    const entity = { id: 'doc-2-0', text: 'changed by alice' };
    const { version } = await alice.command('notes.edit', { docId: 'doc-2', entity });

    expect(await seen).to.deep.equal({ docId: 'doc-2', version, entity, by: 'alice' });
  });

  it('carries binary blobs both ways', async () => {
    const notes = connect('alice-token');
    await online(notes);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);

    const { hash } = await notes.command('blob.put', { bytes });
    expect(hash).to.equal(createHash('sha256').update(bytes).digest('hex'));

    const back = await notes.command('blob.get', { hash });
    expect(Array.from(toBytes(back))).to.deep.equal([0, 1, 2, 250, 255]);

    const missing = await notes.command('blob.get', { hash: '0'.repeat(64) }).then(
      () => null,
      (error: SocketException) => error,
    );
    expect(missing?.code).to.equal('not_found');
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-example && npx ts-mocha -p tsconfig.json test/example.test.ts`
Expected: FAIL with `Cannot find module '../src/client.js'`.

- [ ] **Step 4: Write the contract, the store and the demo principal source**

Create `packages/http-socket-example/src/contract.ts`:

```ts
import { defineContract } from '@spinajs/http-socket-common';

export interface NoteEntity {
  id: string;
  text: string;
}

/** The frames of `notes.snapshot`: a `begin`, then the chunks from `from` on. The stream's own `end` closes it. */
export type SnapshotFrame = { kind: 'begin'; docId: string; version: number; chunks: number; from: number } | { kind: 'chunk'; index: number; entities: NoteEntity[] };

/** Binary arrives as a Buffer ( a Uint8Array ) in Node and as an ArrayBuffer in browsers. */
export type Bytes = ArrayBuffer | Uint8Array;

/** Shared by the server and the client; `type`, not `interface`, so it fits ContractShape. */
export type NotesContract = {
  commands: {
    'notes.open': [{ docId: string }, { docId: string; version: number; chunks: number; openedBy: string }];
    'notes.snapshot': [{ docId: string; version?: number; fromChunk?: number }, AsyncIterable<SnapshotFrame>];
    'notes.edit': [{ docId: string; entity: NoteEntity }, { version: number }];
    'blob.put': [{ bytes: Bytes }, { hash: string }];
    'blob.get': [{ hash: string }, Bytes];
  };
  events: {
    'notes.changed': { docId: string; version: number; entity: NoteEntity; by: string };
  };
  clientEvents: Record<string, never>;
};

export const notesContract = defineContract<NotesContract>();
```

Create `packages/http-socket-example/src/store.ts`:

```ts
import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import type { NoteEntity } from './contract.js';

export const ENTITIES_PER_CHUNK = 5;
export const NOTES_PER_DOC = 100;

export interface INoteDoc {
  version: number;
  entities: NoteEntity[];
}

export function chunkCount(entities: readonly NoteEntity[]): number {
  return Math.ceil(entities.length / ENTITIES_PER_CHUNK);
}

/** In memory and in one process: enough to show the protocol, not a storage design. */
@Injectable()
export class NotesStore {
  protected docs = new Map<string, INoteDoc>();
  protected blobs = new Map<string, Uint8Array>();

  /** The first chunk of every snapshot stream the server started, for the resume demo. */
  public readonly snapshotStarts: number[] = [];

  public doc(docId: string): INoteDoc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { version: 1, entities: Array.from({ length: NOTES_PER_DOC }, (_, i) => ({ id: `${docId}-${i}`, text: `note ${i}` })) };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  public edit(docId: string, entity: NoteEntity): number {
    const doc = this.doc(docId);
    const at = doc.entities.findIndex((e) => e.id === entity.id);
    if (at >= 0) {
      doc.entities[at] = entity;
    } else {
      doc.entities.push(entity);
    }
    doc.version++;
    return doc.version;
  }

  public putBlob(bytes: Uint8Array): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.blobs.set(hash, new Uint8Array(bytes));
    return hash;
  }

  public blob(hash: string): Uint8Array | undefined {
    return this.blobs.get(hash);
  }
}
```

Create `packages/http-socket-example/src/auth.ts`:

```ts
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';

export interface DemoUser {
  name: string;
}

const DEMO_TOKENS = new Map<string, { id: string; user: DemoUser }>([
  ['alice-token', { id: '1', user: { name: 'alice' } }],
  ['bob-token', { id: '2', user: { name: 'bob' } }],
]);

/**
 * Demo only: two fixed tokens. A real app uses AuthnCredentialSource ( bearer tokens, keys and
 * signatures through @spinajs/authn, built in ) or the session-cookie source of @spinajs/authn-http/socket.
 */
@Injectable(SocketPrincipalSource)
export class DemoTokenSource extends SocketPrincipalSource {
  public readonly name = 'demo';
  public readonly order = 10;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    const known = typeof token === 'string' ? DEMO_TOKENS.get(token) : undefined;

    if (!known) {
      return null;
    }

    return Object.freeze({ type: 'user', id: known.id, authenticated: true, source: 'demo', attributes: Object.freeze({}), identity: known.user });
  }
}
```

- [ ] **Step 5: Write the socket controllers**

Create `packages/http-socket-example/src/notes.socket.ts`:

```ts
import { Autoinject } from '@spinajs/di';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { BaseSocketController, Command, Connection, Payload, Signal, SocketConnection, SocketController, SocketHub } from '@spinajs/http-socket';
import type { NotesContract, SnapshotFrame } from './contract.js';
import type { DemoUser } from './auth.js';
import { ENTITIES_PER_CHUNK, NotesStore, chunkCount } from './store.js';

/** The payload type of a contract command. */
type In<N extends keyof NotesContract['commands']> = NotesContract['commands'][N][0];
type NotesConnection = SocketConnection<Record<string, unknown>, DemoUser>;

const DOC_ID = { type: 'string', minLength: 1, maxLength: 64 };
const OpenSchema = { type: 'object', required: ['docId'], properties: { docId: DOC_ID }, additionalProperties: false };
const SnapshotSchema = { type: 'object', required: ['docId'], properties: { docId: DOC_ID, version: { type: 'integer', minimum: 1 }, fromChunk: { type: 'integer', minimum: 0 } }, additionalProperties: false };
const EditSchema = {
  type: 'object',
  required: ['docId', 'entity'],
  properties: {
    docId: DOC_ID,
    entity: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, text: { type: 'string', maxLength: 10_000 } }, additionalProperties: false },
  },
  additionalProperties: false,
};
const HashSchema = { type: 'object', required: ['hash'], properties: { hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, additionalProperties: false };

@SocketController('notes')
export class NotesSocket extends BaseSocketController {
  @Autoinject()
  protected Store: NotesStore;

  @Autoinject()
  protected Hub: SocketHub;

  /** Joins the document's room, so the connection receives `notes.changed`. */
  @Command('open', { schema: OpenSchema })
  public async open(@Payload() req: In<'notes.open'>, @Connection() conn: NotesConnection) {
    const doc = this.Store.doc(req.docId);
    conn.join(`doc:${req.docId}`);
    return { docId: req.docId, version: doc.version, chunks: chunkCount(doc.entities), openedBy: conn.user?.name ?? 'nobody' };
  }

  /**
   * A stream reply. It resumes at `fromChunk` while the document is still at `version`, and starts
   * over at chunk 0 otherwise; `begin.from` tells the client which.
   */
  @Command('snapshot', { schema: SnapshotSchema })
  public async *snapshot(@Payload() req: In<'notes.snapshot'>, @Signal() signal: AbortSignal): AsyncGenerator<SnapshotFrame> {
    const doc = this.Store.doc(req.docId);
    const version = doc.version;
    // a copy: edits made while the snapshot streams must not shift its chunks
    const entities = [...doc.entities];
    const chunks = chunkCount(entities);
    const from = req.version === version && req.fromChunk !== undefined ? Math.min(req.fromChunk, chunks) : 0;
    this.Store.snapshotStarts.push(from);

    yield { kind: 'begin', docId: req.docId, version, chunks, from };

    for (let index = from; index < chunks && !signal.aborted; index++) {
      yield { kind: 'chunk', index, entities: entities.slice(index * ENTITIES_PER_CHUNK, (index + 1) * ENTITIES_PER_CHUNK) };
    }
  }

  @Command('edit', { schema: EditSchema })
  public async edit(@Payload() req: In<'notes.edit'>, @Connection() conn: NotesConnection) {
    const version = this.Store.edit(req.docId, req.entity);
    const changed: NotesContract['events']['notes.changed'] = { docId: req.docId, version, entity: req.entity, by: conn.user?.name ?? 'nobody' };
    this.Hub.to(`doc:${req.docId}`).emit('notes.changed', changed);
    return { version };
  }
}

@SocketController('blob')
export class BlobSocket extends BaseSocketController {
  @Autoinject()
  protected Store: NotesStore;

  /** Binary payload parts arrive as a Buffer, which is a Uint8Array. */
  @Command('put')
  public async put(@Payload() req: In<'blob.put'>) {
    if (!(req?.bytes instanceof Uint8Array)) {
      throw new InvalidArgument('bytes must be binary');
    }
    return { hash: this.Store.putBlob(req.bytes) };
  }

  @Command('get', { schema: HashSchema })
  public async get(@Payload() req: In<'blob.get'>) {
    const blob = this.Store.blob(req.hash);
    if (!blob) {
      throw new ResourceNotFound(`no blob ${req.hash}`);
    }
    return blob;
  }
}
```

- [ ] **Step 6: Write the server bootstrap, the client helpers and the runnable demo**

Create `packages/http-socket-example/src/server.ts`:

```ts
import '@spinajs/log';
import { createServer, Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SocketHttpHost, SocketServer } from '@spinajs/http-socket';
import { NotesStore } from './store.js';
import './auth.js';
import './notes.socket.js';

/** socket.io attaches to this plain node http server. An app on @spinajs/http needs no host of its own: the default HttpServerHost uses that server. */
export class NotesHttpHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

DI.register(NotesHttpHost).as(SocketHttpHost);

export interface INotesServerOptions {
  /** 0 or absent: a free port */
  port?: number;
  /** log to the console; tests keep it quiet */
  verbose?: boolean;
  /** merged over this example's `http.socket` settings */
  socket?: Record<string, unknown>;
}

let current: INotesServerOptions = {};

/** The example's settings, merged over the package defaults ( `http.socket` of @spinajs/http-socket ). */
export class NotesConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    const verbose = current.verbose === true;

    return {
      logger: {
        targets: [verbose ? { name: 'Console', type: 'ConsoleTarget' } : { name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: verbose ? 'info' : 'trace', target: verbose ? 'Console' : 'Empty' }],
      },
      http: {
        socket: {
          // a handshake without one of the demo tokens is refused instead of running as UNATTENDED
          auth: { required: true, revalidateMs: 60_000 },
          streams: { maxCredits: 16 },
          ...current.socket,
        },
      },
    };
  }
}

export interface INotesServer {
  url: string;
  path: string;
  server: SocketServer;
  store: NotesStore;
  close(): Promise<void>;
}

export async function startNotesServer(options: INotesServerOptions = {}): Promise<INotesServer> {
  current = options;
  DI.clearCache();
  DI.register(NotesConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const host = DI.resolve(SocketHttpHost) as NotesHttpHost;
  const server = await DI.resolve(SocketServer);
  await new Promise<void>((resolve) => host.Http.listen(options.port ?? 0, '127.0.0.1', () => resolve()));
  const { port } = host.Http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    path: DI.get(Configuration)!.get<string>('http.socket.path'),
    server,
    store: DI.resolve(NotesStore) as NotesStore,
    close: async () => {
      await server.dispose();
      host.Http.closeAllConnections();
      await new Promise<void>((resolve) => host.Http.close(() => resolve()));
    },
  };
}
```

Create `packages/http-socket-example/src/client.ts`:

```ts
import { SocketClient, SocketException, type SocketClientOptions, type TypedSocketClient } from '@spinajs/http-socket-client';
import { notesContract, type Bytes, type NoteEntity, type NotesContract } from './contract.js';

export type NotesClient = TypedSocketClient<NotesContract>;

/** A typed client signed in with a demo token. In a real app `clientId` is stable per install. */
export function connectNotes(url: string, path: string, token: string, options: Partial<SocketClientOptions> = {}): NotesClient {
  const client = new SocketClient({
    url,
    path,
    clientId: `notes-${token}`,
    auth: () => ({ token }),
    io: { transports: ['websocket'] },
    ...options,
  });

  return client.typed(notesContract);
}

/** Binary results arrive as a Buffer in Node and as an ArrayBuffer in browsers. */
export function toBytes(data: Bytes): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export interface ISnapshot {
  version: number;
  entities: NoteEntity[];
  /** stream calls it took; 1 without a drop */
  attempts: number;
}

export interface ILoadSnapshotOptions {
  credits?: number;
  maxAttempts?: number;
  /** after each applied chunk */
  onChunk?: (index: number) => void;
}

/**
 * Reads a whole snapshot. After a retryable failure ( a dropped connection ) it waits until the client
 * is online again and resumes from the first chunk it has not applied, unless the document changed.
 */
export async function loadSnapshot(notes: NotesClient, docId: string, options: ILoadSnapshotOptions = {}): Promise<ISnapshot> {
  const maxAttempts = options.maxAttempts ?? 5;
  let entities: NoteEntity[] = [];
  let version: number | undefined;
  let next = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      const frames = notes.stream('notes.snapshot', { docId, version, fromChunk: next }, { credits: options.credits, whenOffline: 'wait' });

      for await (const frame of frames) {
        if (frame.kind === 'begin') {
          // the server could not resume and starts over at chunk 0
          if (frame.from !== next) {
            entities = [];
            next = frame.from;
          }
          version = frame.version;
          continue;
        }

        if (frame.index !== next) {
          throw new SocketException('internal', `chunk ${frame.index} arrived, expected ${next}`);
        }
        entities = entities.concat(frame.entities);
        next++;
        options.onChunk?.(frame.index);
      }

      return { version: version ?? 0, entities, attempts: attempt };
    } catch (error) {
      if (!(error instanceof SocketException) || !error.retryable || attempt >= maxAttempts) {
        throw error;
      }
    }
  }
}
```

Create `packages/http-socket-example/src/main.ts`:

```ts
import { connectNotes, loadSnapshot, toBytes } from './client.js';
import { startNotesServer } from './server.js';

const server = await startNotesServer({ verbose: process.argv.includes('--verbose') });
const notes = connectNotes(server.url, server.path, 'alice-token');

try {
  const opened = await notes.command('notes.open', { docId: 'welcome' }, { whenOffline: 'wait' });
  console.log(`opened ${opened.docId} v${opened.version} as ${opened.openedBy}, ${opened.chunks} chunks`);

  const snapshot = await loadSnapshot(notes, 'welcome', { credits: 4 });
  console.log(`snapshot v${snapshot.version}: ${snapshot.entities.length} notes`);

  const { hash } = await notes.command('blob.put', { bytes: new TextEncoder().encode('hello blob') });
  const back = await notes.command('blob.get', { hash });
  console.log(`blob ${hash.slice(0, 12)}: ${new TextDecoder().decode(toBytes(back))}`);
} finally {
  notes.close();
  await server.close();
}
```

Create `packages/http-socket-example/README.md`:

````md
# @spinajs/http-socket-example

A notes server on `@spinajs/http-socket` and its client on `@spinajs/http-socket-client`. It shows:

- a typed contract shared by both sides (`src/contract.ts`)
- commands with ajv schemas, and a room push (`notes.open`, `notes.edit`, `notes.changed`)
- a snapshot as a stream reply with a credit window, resumed with `fromChunk` after a dropped connection (`notes.snapshot`, `loadSnapshot` in `src/client.ts`)
- binary payloads and results (`blob.put`, `blob.get`)
- a principal source; this demo one knows two fixed tokens

## Run

From the repository root, after `npm run build`:

```
cd packages/http-socket-example
npm run compile
npm start            # or: node lib/mjs/main.js --verbose
```

## Test

```
cd packages/http-socket-example
npx ts-mocha -p tsconfig.json test/example.test.ts
```
````

- [ ] **Step 7: Run the tests to see them pass**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-example && npx ts-mocha -p tsconfig.json test/example.test.ts`
Expected: PASS, 6 passing.

If startup fails with a `RangeError` about an `http.socket` key, the built `packages/http-socket/lib/mjs/config/http-socket.js` is missing or stale. Rebuild the server (Global Constraints, "Builds") and run again.

- [ ] **Step 8: Build and run the demo**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-example/tsconfig.mjs.json`
Expected: exits 0.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/http-socket-example && node lib/mjs/main.js`
Expected: these three lines, then the process exits:

```
opened welcome v1 as alice, 20 chunks
snapshot v1: 100 notes
blob e997afd18e5f: hello blob
```

The blob line shows the first 12 hex characters of `sha256('hello blob')`.

- [ ] **Step 9: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket-example/package.json packages/http-socket-example/tsconfig.json packages/http-socket-example/tsconfig.mjs.json packages/http-socket-example/.mocharc.json packages/http-socket-example/.gitignore packages/http-socket-example/README.md packages/http-socket-example/src packages/http-socket-example/test tsconfig.build.json && \
git commit -m "feat(http-socket-example): notes server and client with a resumable snapshot stream, rooms and binary blobs"
```

---

### Task 8: READMEs

**Files:**
- Modify (replace the stub): `packages/http-socket/README.md`
- Create: `packages/http-socket-client/README.md`, `packages/http-socket-common/README.md`

**Interfaces:**
- Consumes: the public APIs of W1, W2 and Tasks 1–7. Every name used below exists in the packages' `src/index.ts` after Task 6.
- Produces: user documentation. W3 appends its own sections later (see "Parallelism with W3").

- [ ] **Step 1: Write the server README**

Replace the whole content of `packages/http-socket/README.md` with:

````md
# @spinajs/http-socket

WebSocket server for spinajs apps, on socket.io 4.8. It provides:

- socket controllers with request/response commands, fire-and-forget events and stream replies with flow control
- rooms and server push
- authentication through authz-v3 principals, with policies and `@SocketAccess`
- ajv validation of payloads
- one error shape, mapped from spinajs exceptions
- limits and metrics

The client is `@spinajs/http-socket-client` (browser and Node). Both speak the protocol of `@spinajs/http-socket-common`, which this package re-exports.

A runnable server and client are in `packages/http-socket-example`.

## Start the server

By default, `SocketServer` attaches socket.io to the http server of `@spinajs/http` (`HttpServerHost`). Resolve it after `HttpServer`, before or after `start()`:

```ts
import { DI } from '@spinajs/di';
import { HttpServer } from '@spinajs/http';
import { SocketServer } from '@spinajs/http-socket';

const http = await DI.resolve(HttpServer);
await DI.resolve(SocketServer);
await http.start();
```

To attach to another node http(s) server, register your own `SocketHttpHost`:

```ts
import { createServer } from 'node:http';
import { DI } from '@spinajs/di';
import { SocketHttpHost } from '@spinajs/http-socket';

export class PlainHttpHost extends SocketHttpHost {
  public readonly Http = createServer();

  public async server() {
    return this.Http;
  }
}

DI.register(PlainHttpHost).as(SocketHttpHost);
```

Socket controllers are found in the folders listed in `system.dirs.socketControllers`, or by importing their modules. Keep them out of `system.dirs.controllers`, because the http loader scans those.

`SocketServer.dispose()` closes every connection. Running commands and streams end with `unavailable`.

## Controllers

```ts
import { Autoinject } from '@spinajs/di';
import { BaseSocketController, Command, Connection, OnConnect, OnDisconnect, OnEvent, Payload, Reason, Signal, SocketConnection, SocketController, SocketHub } from '@spinajs/http-socket';

@SocketController('docs') // command and event names get the prefix: 'docs.open'
export class DocsSocket extends BaseSocketController {
  @Autoinject()
  protected Hub: SocketHub;

  @Command('open', { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, timeoutMs: 10_000 })
  public async open(@Payload() req: { id: string }, @Connection() conn: SocketConnection) {
    conn.join(`doc:${req.id}`);
    return { id: req.id, user: conn.user ?? null };
  }

  @Command('export')
  public async export(@Payload() req: { id: string }, @Signal() signal: AbortSignal) {
    // the signal fires on the deadline, a client cancel, a disconnect or shutdown
    return renderExport(req.id, signal);
  }

  @OnEvent('cursor')
  public async cursor(@Payload() at: { x: number; y: number }, @Connection() conn: SocketConnection) {
    this.Hub.to('docs:cursors').emit('docs.cursor', { by: conn.id, at });
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {}

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection, @Reason() reason: string) {}
}
```

- **Arguments:**
  - `@Payload(schema?)` is validated against the command `schema`, else the `@Payload` schema, else the DTO's `@Schema`, then hydrated as an http body is.
  - `@Connection()` gives the `SocketConnection`: `id`, `clientId`, `principal`, `user` (the principal's `identity`), `rooms`, `data`, `join`, `leave`, `emit`, `disconnect`.
  - `@Signal()`, `@Reason()` (disconnect hooks) and `@FromDI()` are also available.
- **Principal.** There is no `@User()` decorator; read `conn.user` instead. `AuthzService.current()` is the connection principal inside every handler.
- **Results.** A handler that returns nothing answers `null`. Throw to answer with an error (see Errors).
- **Events.** `@OnEvent` handlers are fire-and-forget. A failing event is logged and dropped.
- **Hooks.** `@OnConnect` / `@OnDisconnect` hooks run no policies. Commands wait until the connect hooks are done, up to `hooks.connectTimeoutMs`.

## The command pipeline

Every command passes these stages in order. The first stage that fails answers with its error.

1. **Size.** Over `maxPayloadBytes` answers `resource_exhausted`, not retryable, with `details { size, limit }`.
2. **Rate.** A token bucket per connection answers `resource_exhausted` with `retryAfterMs`.
3. **In flight.** More than `maxInFlightPerConnection` answers `resource_exhausted` with `retryAfterMs: 100`.
4. **Ready.** The command waits for the connection's connect hooks.
5. **Authentication.** The principal is re-checked (expiry, revalidation); a failure answers `unauthenticated`.
6. **Lookup.** An unknown name answers `unimplemented`.
7. **Policies.** `@SocketPolicy` / `@SocketAccess` answer `unauthenticated` or `forbidden`.
8. **Arguments.** Extraction and ajv validation answer `invalid_argument`, with the validation errors in `details`.
9. **Ordering.** `ordered: 'connection' | 'client'` waits in a serial queue.
10. **Handler.** It runs with an `AbortSignal`.

Order 500, between lookup and policies, is reserved for idempotency. A stage of your own is a DI class:

```ts
import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '@spinajs/http-socket';

@Injectable(SocketCommandStage)
export class AuditStage extends SocketCommandStage {
  public get Order() {
    return STAGE_ORDER.Policies + 10;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>) {
    const result = await next();
    audit(ctx.connection.principal, ctx.request.name);
    return result;
  }
}
```

## Errors

Every failure reaches the client as one shape, `{ code, message, retryable, retryAfterMs?, details?, errorId? }`.

| Thrown (`@spinajs/exceptions`, `@spinajs/authz`) | Code | Retryable |
|---|---|---|
| `InvalidArgument`, `BadRequest`, `JsonValidationFailed`, `ValidationFailed` | `invalid_argument` | no |
| `AuthenticationFailed`, `Unauthenticated` | `unauthenticated` | no |
| `Forbidden`, `AccessDenied` | `forbidden` | no |
| `ResourceNotFound` | `not_found` | no |
| `ResourceDuplicated` | `conflict` | no |
| `InvalidOperation` | `failed_precondition` | no |
| `NotSupported`, `MethodNotImplemented` | `unimplemented` | no |
| deadline / client cancel | `deadline_exceeded` / `cancelled` | yes / no |
| rate and in-flight limits / shutdown | `resource_exhausted` / `unavailable` | yes |
| size limit | `resource_exhausted` | no |
| `SocketException(code, message, options)` | its code | its flag |
| anything else | `internal` | no |

Lookup walks the prototype chain, so a domain subclass of `Forbidden` answers `forbidden`. In production an `internal` error hides its message; the `errorId` it returns matches the server log line. To map an exception of your own:

```ts
import { HandleSocketException, SocketError, SocketErrorMapping } from '@spinajs/http-socket';

@HandleSocketException(QuotaExceeded)
export class QuotaExceededMapping extends SocketErrorMapping {
  public map(error: Error): SocketError {
    return { code: 'resource_exhausted', message: error.message, retryable: true, retryAfterMs: 60_000 };
  }
}
```

## Stream replies

A command whose handler returns an async iterable answers with a stream:

```ts
@Command('snapshot')
public async *snapshot(@Payload() req: { docId: string; fromChunk?: number }, @Signal() signal: AbortSignal) {
  const doc = await this.Docs.load(req.docId);
  yield { kind: 'begin', chunks: doc.chunks.length };
  for (let index = req.fromChunk ?? 0; index < doc.chunks.length && !signal.aborted; index++) {
    yield { kind: 'chunk', index, data: doc.chunks[index] };
  }
}
```

- **On the wire.** The ack is `{ id, ok: true, stream: true }`. Then come `chunk { id, seq, data }` frames numbered from 0, and finally `end { id, seq }` (`seq` = the number of chunks) or `fail { id, error }`. An `undefined` item is sent as `null`. Binary parts (`Uint8Array`, `ArrayBuffer`, `Buffer`) travel as socket.io attachments.
- **Flow control.** The client's request carries `credits`, its window (8 by default). The server asks the generator for the next item only while it holds credit, so a slow consumer slows the producer and nothing piles up in memory. The client grants more as it reads. Finding the end of a stream also takes one unit of credit.
- **Stopping.** A client `cancel` (a `break` out of `for await`), a disconnect and shutdown fire the handler's signal and run the generator's `finally`. A stream that gets no credit for `streams.stallTimeoutMs` (60 s) fails with `deadline_exceeded`. A generator that throws ends the stream with `fail`, after the chunks it already sent.
- **Context.** Every step runs inside the call's AsyncLocalStorage store, so `AuthzService.current()` and the log context are the connection's.
- **Limits:**
  - `credits` above `streams.maxCredits` (64), at the request or by a later grant, fails with `invalid_argument`.
  - More than `streams.maxPerConnection` (8) open streams on a connection answers `resource_exhausted`.
  - An open stream holds no `maxInFlightPerConnection` slot.
- **Timeouts.** `deadline` and `@Command({ timeoutMs })` bound the time until the stream reply only.
- **Ordering.** A stream handler cannot be `ordered`; the server refuses to start with `InvalidOperation` when one is.
- **Plain calls.** A stream command called with `client.command()` (no `credits`) answers `failed_precondition`, and its generator never starts.
- **Resume.** A dropped connection ends the stream on both sides. To resume, put the position in the payload (`fromChunk` above), and let the client restart from the first chunk it has not applied. `loadSnapshot` in `packages/http-socket-example/src/client.ts` is a complete client.

## Rooms and push

`SocketHub` is injectable:

- `to(room | rooms).emit(name, payload)`: every connection in the rooms
- `toConnection(id).emit(name, payload)`
- `join(connectionId, room)`, `leave(connectionId, room)`, `connectionsIn(room)`
- `disconnect(connectionId, reason)`: sends `sys.disconnect { reason }`, then closes
- `connection(id)`, `Connections`: connections on this instance

Rooms are a server decision; clients ask through ordinary commands. Push names must be valid names (`[\w.:-]`, at most 128 characters), and the `sys.` prefix is reserved. Give server events a dotted prefix (`docs.committed`): the client's lifecycle names (`state`, `auth_required`, `incompatible`, `refused`, `failed`) shadow server events of the same name.

## Authentication and access

- **Principal sources.** A handshake is turned into an authz-v3 `Principal` by the registered `SocketPrincipalSource`s, in ascending `order`. The first non-null principal wins, and a throw refuses the handshake with `unauthenticated`.
- **Built-in source.** `AuthnCredentialSource` (order 50) authenticates bearer tokens, keys and signatures through `@spinajs/authn`. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers. Cookies are never read by this source.
- **No credentials.** A connection without credentials runs as `UNATTENDED`, so authz denies it and scoped ORM queries fail closed. `http.socket.auth.required: true` refuses such handshakes instead.
- **Origins.** A handshake from a browser page on another origin is refused with `forbidden` unless that origin is listed exactly in `http.socket.cors.origins` (empty by default).
- **Revalidation.** Live connections re-check their principal every `http.socket.auth.revalidateMs` (60 s), and `ceiling.expiresAt` is always enforced. A revoked credential gets `unauthenticated`, and the server closes the connection with `sys.disconnect { reason: 'unauthenticated' }`.

A source of your own:

```ts
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { ISocketHandshake, SocketPrincipalSource } from '@spinajs/http-socket';

@Injectable(SocketPrincipalSource)
export class ApiKeySource extends SocketPrincipalSource {
  public readonly name = 'api-key';
  public readonly order = 60;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const key = handshake.auth.apiKey;
    return typeof key === 'string' ? lookUpServicePrincipal(key) : null;
  }
}
```

Access checks:

```ts
@SocketController('docs')
@SocketPolicy(SignedInPolicy)                 // http BasePolicy classes: AND inside one call, OR across calls
export class DocsSocket extends BaseSocketController {
  @Command('read')
  @SocketAccess('docs:read', { resource: fromPayload('id', 'docs') })
  public async read(@Payload() req: { id: string }) {}
}
```

## Configuration (`http.socket`)

| Key | Default | Meaning |
|---|---|---|
| `path` | `'/socket.io'` | socket.io endpoint |
| `cors.origins` | `[]` | other origins allowed to open a socket; exact strings, no wildcards |
| `auth.required` | `false` | refuse handshakes no source resolves |
| `auth.revalidateMs` | `60_000` | principal re-check interval; `0` turns it off (expiry still applies) |
| `pingInterval`, `pingTimeout` | `25_000`, `20_000` | socket.io heartbeats |
| `recovery.maxDisconnectionMs` | `120_000` | connection state recovery window |
| `maxPayloadBytes` | `1048576` | command and event payload limit; binary parts count by byte length |
| `maxInFlightPerConnection` | `32` | commands running at once per connection |
| `maxInFlightEventsPerConnection` | `128` | events waiting or running per connection; at least `rate.burst` |
| `rate` | `{ perSecond: 50, burst: 100 }` | token bucket per connection |
| `ordering.abortGraceMs` | `30_000` | how long an aborted `ordered` command keeps its queue place |
| `hooks.connectTimeoutMs` | `10_000` | how long commands wait for connect hooks |
| `streams.maxCredits` | `64` | largest credit window per stream |
| `streams.maxPerConnection` | `8` | open streams per connection |
| `streams.stallTimeoutMs` | `60_000` | a stream without credit this long fails |
| `transports` | `['websocket', 'polling']` | engine.io transports; prefer `['websocket']` with cookie authentication |
| `adapter` | `undefined` | socket.io adapter for several instances |

`system.dirs.socketControllers` (default `[]`) lists the folders scanned for socket controllers. An invalid limit stops the server at startup with a `RangeError`.

## Observability

- **Debug lines.** One per command (`socket command <name> <code> <ms>ms connection <id>`) and one per stream (`socket stream <name> <outcome> <n> chunks <ms>ms connection <id>`).
- **Metrics** (through `@spinajs/telemetry`): `socket_commands_total{command, code}`, `socket_command_duration_seconds{command}`, `socket_connections` and `socket_streams_total{command, code}`. Only registered command names become labels.
- **Tracing.** An inbound `traceparent` is carried into the handler's log context.

## Several instances

Set `http.socket.adapter` to a socket.io adapter (for example Redis) so rooms and pushes reach every instance, and use sticky sessions with the polling transport. Ordering queues, open streams and the closing filter of the principal guard are per instance.
````

- [ ] **Step 2: Write the client README**

Create `packages/http-socket-client/README.md`:

````md
# @spinajs/http-socket-client

Client for `@spinajs/http-socket`, for browsers and Node. It handles the connection state, reconnects with backoff, and offers commands with timeouts and cancellation, server events, stream replies with flow control, and typed contracts. Its only dependencies are `socket.io-client` and `@spinajs/http-socket-common`, which it re-exports.

## Connect

```ts
import { SocketClient } from '@spinajs/http-socket-client';

const client = new SocketClient({
  url: 'https://app.example.com',
  clientId: storedClientId,                               // stable per install; generated when omitted
  auth: async () => ({ token: await tokens.current() }),  // asked on every (re)connect
  reconnect: { minMs: 500, maxMs: 30_000, jitter: 0.3 },   // the defaults
  defaultTimeoutMs: 15_000,                                // the default
});
```

- The client connects on its own unless `autoConnect: false`.
- `client.state` is `'connecting' | 'online' | 'offline' | 'closed'`, and `client.on('state', (state, previous) => …)` reports every change.
- `disconnect()` goes offline until `connect()`. `close()` is final: it rejects everything pending.

**Reconnect.** The client retries with exponential backoff and jitter, and asks `auth()` again on every attempt. It stops in these cases:

| Server answer | Lifecycle event |
|---|---|
| `unauthenticated` | `auth_required` |
| `version_mismatch` | `incompatible` |
| any other refusal with `retryable: false` (`forbidden` for a foreign origin, `invalid_argument` …) | `refused` |

`connect()` tries again. A `sys.shutdown { retryAfterMs }` notice delays the next attempt.

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
client.emit('docs.cursor', { x, y });   // fire-and-forget; false and dropped when not online
```

## Streams

```ts
for await (const frame of client.stream<SnapshotFrame>('docs.snapshot', { docId }, { credits: 8 })) {
  apply(frame);
  if (cancelled) break;   // sends cancel; the server generator's finally runs
}
```

- `stream()` returns an async iterator. The request goes out on the first `next()`.
- **Flow control.**
  - `credits` (default `DEFAULT_STREAM_CREDITS`, 8) is the most chunks that are ever in flight or buffered.
  - The client grants more as you read, in batches of half the window.
  - It must not exceed the server's `http.socket.streams.maxCredits` (64).
- **Timeouts.** `timeoutMs` bounds the wait for the reply, and then each wait in `next()` for the next frame. A consumer that is slow to call `next()` is never timed out. The server ends a stream that gets no credit for its `streams.stallTimeoutMs`.
- **Failures.** On a server `fail`, a dropped connection (`unavailable`, retryable) or a closed client, the chunks already received are delivered first, then the iterator throws. Aborting `signal` drops buffered chunks, cancels the stream and throws `cancelled`.
- **Mismatches.** `stream()` on a command that answers a plain result throws `failed_precondition`, and so does `command()` on a stream command.
- **Resume.** The library does not resume streams. Put the position in the payload (for example `fromChunk`) and start a new stream after a retryable failure; with `whenOffline: 'wait'` it waits for the reconnect. `loadSnapshot` in `packages/http-socket-example/src/client.ts` is a complete example.

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
const opened = await docs.command('docs.open', { id: 'a' });                    // { title: string }
for await (const frame of docs.stream('docs.snapshot', { docId: 'a' })) {}      // frame: SnapshotFrame
docs.on('docs.committed', ({ seq }) => {});
```

Declare contracts with `type`, not `interface`. A stream command declares its result as `AsyncIterable<Item>`.

## Binary

`Uint8Array`, `ArrayBuffer` and `Buffer` anywhere in a payload travel as binary attachments and count toward the server's `maxPayloadBytes` by byte length. Binary results arrive as an `ArrayBuffer` in browsers and as a `Buffer` in Node; `new Uint8Array(result)` reads both.
````

- [ ] **Step 3: Write the common README**

Create `packages/http-socket-common/README.md`:

````md
# @spinajs/http-socket-common

The wire protocol shared by `@spinajs/http-socket` (server) and `@spinajs/http-socket-client`. It has no dependencies and runs in browsers and Node. Both packages re-export it, so apps rarely import it directly.

- `PROTOCOL_VERSION` (1) and the wire event names `WIRE_EVENTS`:
  - commands: `cmd`
  - events in both directions: `evt`
  - stream frames, server to client: `chunk`, `end`, `fail`
  - client to server: `credit`, `cancel`
- `SYSTEM_EVENTS`: `sys.shutdown`, `sys.disconnect`.
- The envelopes:
  - `Handshake`
  - `CommandRequest` (`id`, `name`, `payload`, `deadline`, `idempotencyKey`, `traceparent`, and `credits` for streams)
  - `CommandReply`
  - `EventFrame`
  - the stream frames `Chunk`, `StreamEnd`, `StreamFail`, `StreamCredit`, and `CancelFrame`
- Guards for them: `isCommandRequest`, `isEventFrame`, `isCancelFrame`, `isChunk`, `isStreamEnd`, `isStreamFail`, `isStreamCredit`.
- Names and ids: `isName` / `NAME_PATTERN` / `MAX_NAME_LENGTH` and `isId` / `ID_PATTERN` / `MAX_ID_LENGTH`.
- The 13 error codes:
  - `ErrorCode`, `ERROR_CODES`, `DEFAULT_RETRYABLE`
  - the wire shape `SocketError` and its guard `isSocketError`
  - `SocketException`, a throwable `SocketError` with `toWire()` / `fromWire()`
- Typed contracts: `defineContract<C>()` and the helper types `CommandName`, `CommandPayload`, `CommandResult`, `EventName`, `EventPayload`, `ClientEventName`, `ClientEventPayload`, `ContractOf`.
````

- [ ] **Step 4: Check the README names against the code**

Run (in Git Bash):

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node -e "
Promise.all([import('@spinajs/http-socket'), import('@spinajs/http-socket-client')]).then(([server, client]) => {
  const need = [
    [server, ['SocketServer', 'SocketHttpHost', 'BaseSocketController', 'Command', 'Connection', 'OnConnect', 'OnDisconnect', 'OnEvent', 'Payload', 'Reason', 'Signal', 'FromDI', 'SocketConnection', 'SocketController', 'SocketHub', 'SocketCommandStage', 'STAGE_ORDER', 'HandleSocketException', 'SocketErrorMapping', 'SocketPrincipalSource', 'SocketPolicy', 'SocketAccess', 'fromPayload', 'AuthnCredentialSource']],
    [client, ['SocketClient', 'defineContract', 'DEFAULT_STREAM_CREDITS', 'SocketException', 'isChunk', 'isStreamCredit']],
  ];
  for (const [mod, names] of need) for (const name of names) if (!(name in mod)) console.log('missing: ' + name);
});
"
```

Expected: no output, which means every class, decorator and constant the READMEs name is exported. `ISocketCommandContext`, `ISocketHandshake` and `SocketError` are types and are not checked here.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/http-socket/README.md packages/http-socket-client/README.md packages/http-socket-common/README.md && \
git commit -m "docs(http-socket): READMEs for the server, the client and the shared protocol"
```

---

## Gated part

Task 9 waits for its gate (see "Gate status"). Tasks 1–8 are complete without it. Run Task 9 only when Step 1's check passes. `feat/websocket-layer` is a shared worktree, so the owner first rebases or merges it onto the current `feat/authz-v3` while no agent is working in it.

### Task 9 (gated): session-cookie principal source `@spinajs/authn-http/socket`

**Gate:**
- authz-v3 lanes **N2** (`authn-session`: `SessionIssuer` implementation, `sessionCookieName`, `appEnvOf`) and **N8a** (`authn-http`: `AuthnMiddleware`, `SessionPrincipalResolver`, `ClientIp`) are merged into `feat/authz-v3`, and that branch is merged into `feat/websocket-layer`.
- The owner answer to Q1 of the W1 brief is recorded: the session source goes into `@spinajs/authn-http` under the subpath `./socket`.
- On 2026-10-03, N2 sat unmerged on `authz/N2-session` (d090fb508), and N8a had no branch.

**Files:**
- Create: `packages/authn-http/src/socket/index.ts`, `packages/authn-http/src/socket/session-source.ts`
- Modify: `packages/authn-http/package.json` (`exports["./socket"]`, `typesVersions`, `peerDependencies`, `peerDependenciesMeta`, `devDependencies`)
- Modify: `packages/authn-http/tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json` (reference `http-socket`)
- Test: `packages/authn-http/test/socket-session.test.ts`
- Modify: `packages/http-socket/README.md` ("Authentication and access"), `packages/http-socket/RELEASE_NOTES.md` (the cookie line)

**Interfaces:**
- Consumes:
  - `SessionIssuer.restore(rawId)` and `PrincipalFactory.principalOf(identity, facts, { ceiling })`, from `@spinajs/authn/contracts` (merged).
  - `sessionCookieName(config, env)` and `appEnvOf(config)`, from `@spinajs/authn-session` (N2).
  - `cookie-signature`'s `unsign`.
  - `SocketPrincipalSource` and `ISocketHandshake`, from `@spinajs/http-socket`.
- Produces: `class SessionSocketPrincipalSource extends SocketPrincipalSource`, registered by import (`@Injectable(SocketPrincipalSource)`), with:
  - `name = 'session'` and `order = 40` (Q1 of this plan).
  - **Active session:** the user built by `PrincipalFactory`, with `ceiling.roles = [ActiveRole]` after a role switch.
  - **Pending session:** null (SR-07). An unknown, expired, unsigned or forged cookie: null.
  - **Revalidation:** the inherited default, which restores the session again. A revoked session gives null, which counts as `'invalid'`; a failing store throws, which counts as `'unavailable'`.
- Import path for apps: `import '@spinajs/authn-http/socket';`

- [ ] **Step 1: Check the gate**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && git log --oneline feat/authz-v3 | grep -E "Merge authz/(N2|N8a)" && git merge-base --is-ancestor feat/authz-v3 HEAD && grep -n "export function sessionCookieName\|export function appEnvOf" packages/authn-session/src/cookie.ts && grep -n "class SessionPrincipalResolver" -A12 packages/authn-http/src/api.ts packages/authn-http/src/**/*.ts | grep -v notImplemented | head -20`
Expected:
- two merge lines (N2 and N8a)
- the ancestor check passes
- both cookie helpers are found
- `SessionPrincipalResolver` has a real body, not `notImplemented`.

Otherwise stop: the gate does not hold.

- [ ] **Step 2: Reconcile the four names with the merged code**

Read the merged `SessionPrincipalResolver.resolve` and `AuthnMiddleware` (`packages/authn-http/src/**`) and `packages/authn-session/src/cookie.ts`. Check each line below against them:

1. The session cookie name is `sessionCookieName(config.get('authn.session.cookie', {}), appEnvOf(config))`.
2. The cookie value is `cookie-signature`'s `sign(rawId, config.get('http.cookie.secret'))`, as `@spinajs/http`'s `_setCoockies` writes signed cookies; express-style values carry an `s:` prefix.
3. The role switch is stored under the session data key `'ActiveRole'`, and the resolver builds `ceiling: { roles: [role] }`.
4. A pending session (`handle.state !== 'active'`) gives no principal.

Where the merged code differs, change only the corresponding line of `session-source.ts` in Step 5 and the matching fixture in Step 3 to what N8a does. The structure stays. If N8a exports a function that does items 1–3 from cookies, call it instead and delete `sessionId()`.

- [ ] **Step 3: Write the failing test**

Create `packages/authn-http/test/socket-session.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { createServer, Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as cs from 'cookie-signature';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import { PrincipalFactory, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, Ceiling, IdentityRef, Principal, SessionHandle } from '@spinajs/authn/contracts';
import { AuthnCredentialSource, BaseSocketController, Command, Connection, PROTOCOL_VERSION, SYSTEM_EVENTS, SocketConnection, SocketController, SocketHttpHost, SocketServer, WIRE_EVENTS } from '@spinajs/http-socket';
import type { CommandReply, EventFrame, SocketError } from '@spinajs/http-socket';
import { SessionSocketPrincipalSource } from '../src/socket/index.js';

const SECRET = 'socket-session-test-secret';
const FACTS: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0), sessionHandle: 'handle-1' };

interface ISockSessSession {
  identity: IdentityRef;
  state: 'active' | 'pending';
  data: Map<string, unknown>;
}

export class SockSessIssuer extends SessionIssuer {
  public static sessions = new Map<string, ISockSessSession>();
  public static restores = 0;

  public async restore(rawId: string) {
    SockSessIssuer.restores++;
    const session = SockSessIssuer.sessions.get(rawId);
    return session ? { handle: { id: rawId, state: session.state }, identity: session.identity, facts: FACTS, data: session.data } : null;
  }

  // the socket source uses restore() only
  public issue(): Promise<SessionHandle> {
    throw new Error('not used');
  }
  public rotate(): Promise<SessionHandle> {
    throw new Error('not used');
  }
  public elevate(): Promise<SessionHandle> {
    throw new Error('not used');
  }
  public set(): Promise<void> {
    throw new Error('not used');
  }
  public revoke(): Promise<void> {
    throw new Error('not used');
  }
  public revokeAll(): Promise<number> {
    throw new Error('not used');
  }
  public revokeHandle(): Promise<boolean> {
    throw new Error('not used');
  }
  public list(): Promise<readonly { handle: string; createdAt: Date; lastSeenAt: Date }[]> {
    throw new Error('not used');
  }
}

export class SockSessFactory extends PrincipalFactory {
  public async principalOf(id: IdentityRef, facts: AuthnFacts, extra: { ceiling?: Ceiling }): Promise<Principal> {
    return { type: id.type, id: id.id, authenticated: true, source: 'session', attributes: {}, authn: facts, ...(extra.ceiling ? { ceiling: extra.ceiling } : {}) };
  }
}

export class SockSessHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

@SocketController('sess')
export class SockSessSocket extends BaseSocketController {
  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { type: conn.principal.type, id: conn.principal.id, roles: conn.principal.ceiling?.roles ?? null };
  }
}

let revalidateMs = 60_000;

export class SockSessConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      configuration: { isProduction: false },
      http: { cookie: { secret: SECRET }, socket: { auth: { required: false, revalidateMs } } },
      authn: { session: { cookie: { name: 'ssid', hostPrefix: false } } },
    };
  }
}

const cookieFor = (rawId: string) => `ssid=${encodeURIComponent(cs.sign(rawId, SECRET))}`;

describe('session-cookie socket source ( @spinajs/authn-http/socket )', function () {
  this.timeout(15000);

  let http: NodeHttpServer;
  let server: SocketServer;
  let url: string;
  let path: string;
  const sockets: ClientSocket[] = [];

  async function start(): Promise<void> {
    DI.clearCache();
    DI.register(SockSessConfiguration).as(Configuration);
    DI.register(SockSessHost).as(SocketHttpHost);
    DI.register(SockSessIssuer).as(SessionIssuer);
    DI.register(SockSessFactory).as(PrincipalFactory);
    await DI.resolve(Configuration);

    const host = DI.resolve(SocketHttpHost) as SockSessHost;
    http = host.Http;
    server = await DI.resolve(SocketServer);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    path = DI.get(Configuration)!.get<string>('http.socket.path');
  }

  function connect(headers: Record<string, string>): ClientSocket {
    const socket = io(url, { path, transports: ['websocket'], reconnection: false, forceNew: true, auth: { protocol: PROTOCOL_VERSION, clientId: 'sess-client' }, extraHeaders: headers });
    sockets.push(socket);
    return socket;
  }

  function opened(socket: ClientSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err: Error & { data?: SocketError }) => reject(err));
    });
  }

  async function who(socket: ClientSocket): Promise<unknown> {
    const reply = (await socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, { id: `who-${Date.now()}`, name: 'sess.who', payload: null })) as CommandReply;
    if (!reply.ok || !('result' in reply)) throw new Error(JSON.stringify(reply));
    return reply.result;
  }

  async function stop(): Promise<void> {
    sockets.splice(0).forEach((s) => s.close());
    await server.dispose();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  beforeEach(async () => {
    SockSessIssuer.sessions.clear();
    SockSessIssuer.restores = 0;
    revalidateMs = 60_000;
    await start();
  });

  afterEach(stop);

  it('runs before the bearer source, as an active session wins over bearer credentials in http', () => {
    expect(new SessionSocketPrincipalSource().order).to.be.below(new AuthnCredentialSource().order);
  });

  it('connects an active session cookie as its user, with ActiveRole as the role ceiling', async () => {
    SockSessIssuer.sessions.set('raw-1', { identity: { type: 'user', id: 'u-1' }, state: 'active', data: new Map([['ActiveRole', 'editor']]) });
    const socket = connect({ cookie: cookieFor('raw-1') });
    await opened(socket);

    expect(await who(socket)).to.deep.equal({ type: 'user', id: 'u-1', roles: ['editor'] });
  });

  it('gives no principal for a pending session ( SR-07 )', async () => {
    SockSessIssuer.sessions.set('raw-2', { identity: { type: 'user', id: 'u-2' }, state: 'pending', data: new Map() });
    const socket = connect({ cookie: cookieFor('raw-2') });
    await opened(socket);

    expect(await who(socket)).to.deep.equal({ type: 'unattended', id: 'unattended', roles: null });
  });

  it('ignores an unsigned or forged cookie without asking the session store', async () => {
    SockSessIssuer.sessions.set('raw-3', { identity: { type: 'user', id: 'u-3' }, state: 'active', data: new Map() });
    const socket = connect({ cookie: 'ssid=raw-3.forgedsignature' });
    await opened(socket);

    expect(await who(socket)).to.deep.equal({ type: 'unattended', id: 'unattended', roles: null });
    expect(SockSessIssuer.restores).to.equal(0);
  });

  it('refuses a cross-origin handshake carrying the session cookie before the source runs ( SR-12 )', async () => {
    SockSessIssuer.sessions.set('raw-4', { identity: { type: 'user', id: 'u-4' }, state: 'active', data: new Map() });
    const socket = connect({ cookie: cookieFor('raw-4'), origin: 'https://evil.example' });

    const refusal = await opened(socket).then(
      () => null,
      (err: Error & { data?: SocketError }) => err.data,
    );
    expect(refusal).to.deep.include({ code: 'forbidden', message: 'origin not allowed' });
    expect(SockSessIssuer.restores).to.equal(0);
  });

  describe('revalidation', () => {
    beforeEach(async () => {
      await stop();
      revalidateMs = 100;
      await start();
    });

    it('closes the socket of a revoked session after revalidateMs', async () => {
      SockSessIssuer.sessions.set('raw-5', { identity: { type: 'user', id: 'u-5' }, state: 'active', data: new Map() });
      const socket = connect({ cookie: cookieFor('raw-5') });
      await opened(socket);
      const notice = new Promise<unknown>((resolve) =>
        socket.on(WIRE_EVENTS.event, (frame: EventFrame) => {
          if (frame.name === SYSTEM_EVENTS.disconnect) resolve(frame.payload);
        }),
      );

      SockSessIssuer.sessions.delete('raw-5');

      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });
  });
});
```

- [ ] **Step 4: Run the test to see it fail**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json test/socket-session.test.ts --grep "session-cookie socket source"`
Expected: FAIL with `Cannot find module '../src/socket/index.js'`. The package `.mocharc.json` lists `test/**/*.test.ts`, so mocha loads every test file of the package; `--grep` runs only this suite.

- [ ] **Step 5: Implement the source and the subpath**

Create `packages/authn-http/src/socket/session-source.ts`:

```ts
import { DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { PrincipalFactory, SessionIssuer } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import { SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';
import * as cs from 'cookie-signature';

/** Session data key of a role switch ( SessionIssuer.set ). */
export const ACTIVE_ROLE_KEY = 'ActiveRole';

/**
 * The browser session cookie as a socket principal: the socket form of SessionPrincipalResolver.
 * Order 40, before the bearer source ( 50 ), because an active session ignores bearer credentials in
 * http too; a pending session yields null, so a bearer token is still tried. The origin guard of
 * http-socket refuses cross-site handshakes before any source runs ( SR-12 ).
 */
@Injectable(SocketPrincipalSource)
export class SessionSocketPrincipalSource extends SocketPrincipalSource {
  public readonly name = 'session';
  public readonly order = 40;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const rawId = this.sessionId(handshake);
    if (rawId === null || !DI.check(SessionIssuer) || !DI.check(PrincipalFactory)) {
      return null;
    }

    const issuer = (await DI.resolve(SessionIssuer)) as SessionIssuer;
    const restored = await issuer.restore(rawId);

    // a pending ( pre-MFA ) session is no principal ( SR-07 )
    if (!restored || restored.handle.state !== 'active') {
      return null;
    }

    const role = restored.data.get(ACTIVE_ROLE_KEY);
    const factory = (await DI.resolve(PrincipalFactory)) as PrincipalFactory;
    return factory.principalOf(restored.identity, restored.facts, typeof role === 'string' ? { ceiling: { roles: [role] } } : {});
  }

  /** The raw session id from the signed cookie, or null when it is absent, unsigned or forged. */
  protected sessionId(handshake: ISocketHandshake): string | null {
    const config = DI.get(Configuration);
    const secret = config?.get<string>('http.cookie.secret');
    if (!config || !secret) {
      return null;
    }

    const value = handshake.cookies[sessionCookieName(config.get('authn.session.cookie', {}), appEnvOf(config))];
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }

    const unsigned = cs.unsign(value.startsWith('s:') ? value.slice(2) : value, secret);
    return unsigned === false ? null : unsigned;
  }
}
```

Create `packages/authn-http/src/socket/index.ts`:

```ts
export * from './session-source.js';
```

In `packages/authn-http/package.json`, replace

```json
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
```

with

```json
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    },
    "./socket": {
      "types": "./lib/mjs/socket/index.d.ts",
      "import": "./lib/mjs/socket/index.js",
      "require": "./lib/cjs/socket/index.js"
    }
  },
  "typesVersions": {
    "*": {
      "socket": [
        "lib/cjs/socket/index.d.ts"
      ]
    }
  },
  "peerDependencies": {
    "@spinajs/http-socket": "2.0.548"
  },
  "peerDependenciesMeta": {
    "@spinajs/http-socket": {
      "optional": true
    }
  },
```

and, in its `devDependencies` block, add `"@spinajs/http-socket": "2.0.548",` and `"socket.io-client": "^4.8.1",`. Use the version `packages/http-socket/package.json` carries at that time in place of `2.0.548` if X1 has changed it.

The root `src/index.ts` of `authn-http` must not import `./socket`: `@spinajs/http-socket` stays optional for apps without sockets.

In `packages/authn-http/tsconfig.json`, add `{ "path": "../http-socket/tsconfig.json" }` to `references`. In `tsconfig.mjs.json` add `{ "path": "../http-socket/tsconfig.mjs.json" }`, and in `tsconfig.cjs.json` add `{ "path": "../http-socket/tsconfig.cjs.json" }`.

- [ ] **Step 6: Build and run the test**

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer && node node_modules/typescript-7/lib/tsc.js -b packages/http-socket/tsconfig.mjs.json packages/http-socket/tsconfig.cjs.json packages/authn-http/tsconfig.mjs.json packages/authn-http/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs`
Expected: exits 0.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npx ts-mocha -p tsconfig.json test/socket-session.test.ts --grep "session-cookie socket source"`
Expected: PASS, 6 passing.

Run: `cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer/packages/authn-http && npm test`
Expected: no new failures against the suite's result on the merged `feat/authz-v3`.

- [ ] **Step 7: Document it**

In `packages/http-socket/README.md`, replace the line

```md
- **Built-in source.** `AuthnCredentialSource` (order 50) authenticates bearer tokens, keys and signatures through `@spinajs/authn`. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers. Cookies are never read by this source.
```

with

```md
- **Built-in source.** `AuthnCredentialSource` (order 50) authenticates bearer tokens, keys and signatures through `@spinajs/authn`. The client sends a token as `auth.token`, because browsers cannot set WebSocket headers. Cookies are never read by this source.
- **Session cookie.** `import '@spinajs/authn-http/socket'` registers `SessionSocketPrincipalSource` (order 40). It reads the signed session cookie of `@spinajs/authn-http`, and an active session wins over bearer credentials, as it does in http. A pending (pre-MFA) session is no principal. A revoked session closes the socket at its next revalidation. A session id rotated in http (login, elevation, impersonation) invalidates the socket's handshake cookie, so the client reconnects with the new cookie. Prefer `transports: ['websocket']` with cookies: browsers always send `Origin` on a WebSocket upgrade.
```

In `packages/http-socket/RELEASE_NOTES.md`, replace

```md
Cookies are never a socket credential.
```

with

```md
Cookies are a socket credential only through the opt-in `SessionSocketPrincipalSource` of `@spinajs/authn-http/socket` (order 40); the origin guard refuses cross-site handshakes before it runs.
```

- [ ] **Step 8: Commit**

```bash
cd C:/Users/grzch/SourceCodes/Spinajs/websocket-layer
test "$(git branch --show-current)" = feat/websocket-layer && \
git add packages/authn-http/src/socket/index.ts packages/authn-http/src/socket/session-source.ts packages/authn-http/package.json packages/authn-http/tsconfig.json packages/authn-http/tsconfig.mjs.json packages/authn-http/tsconfig.cjs.json packages/authn-http/test/socket-session.test.ts packages/http-socket/README.md packages/http-socket/RELEASE_NOTES.md && \
git commit -m "feat(authn-http): session-cookie socket principal source at @spinajs/authn-http/socket"
```

---

## Self-review: spec coverage

| Spec requirement | Task |
|---|---|
| §4 `CommandStreamReply`, `Chunk`, `chunk \| end \| fail`, `credit \| cancel` | 1 (guards, `credits`), 3 (server frames), 5 (client frames) |
| §5.1 `async *snapshot` handler returning `AsyncIterable<SnapshotChunk>` | 3 |
| §5.2 step 10 "the result, a stream, or a mapped error" | 3 (`toReply`) |
| §5.2 step 9 signal fires on cancel / disconnect / shutdown, for streams too | 2, 3 (tests: cancel, disconnect; shutdown through `abortAll`, which W3 drives) |
| §5.5 observability (count, errors by code) for streams | 4 |
| §6 "The client grants credits (default 8 chunks) and grants more as the consumer reads" | 5 (`DEFAULT_STREAM_CREDITS`, `replenish`), 6 |
| §6 "Breaking out of the `for await` sends `cancel`, and the server generator's `finally` runs" | 5 (client test), 3 (server test) |
| §6 `client.stream<SnapshotChunk>('docs.snapshot', req)` and typed contracts | 6 |
| §7 Streams row: a slow consumer never has more chunks in flight than its credit | 3 (server: `produced === 2`), 5 (client: `sent − consumed ≤ 4`), 7 (end to end) |
| §7 Streams row: `cancel` runs the generator's `finally` | 2, 3 |
| §8 W4 "the `@spinajs/authn-http/socket` session-cookie source" | 9 (gated) |
| §8 W4 "README and an example app" | 8, 7 |
| Editor spec §6.1 `doc.snapshot` stream with credit flow control and `fromChunk` resume | 7 (`notes.snapshot`, `loadSnapshot`, resume test) |
| Editor spec §6.1 `blob.get` / `blob.put` binary | 7 (binary test), 3 (binary chunks), 5 (binary chunks on the client) |
| W1 brief "Coordination with W4": replace the stream branch of `toReply`, reuse `onCancel`, keep the ALS store after the ack | 3 (`toReply`, cancel through `running`, `within` = `Als.run`) |
| W1 brief G6: order, cookie name and secret, `SessionIssuer.restore`, pending ⇒ none, `ceiling.roles` from `ActiveRole`, `PrincipalFactory`, revalidation by restore; tests SR-07, SR-12, revoked session | 9 |
| W2 seams: `connection.listen` / `send` / `request`, `events.on('state')`, ids from `CommandDispatcher.nextId()` | 5, 6 |
