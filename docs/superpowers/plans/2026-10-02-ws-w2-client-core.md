# W2 Client core (`@spinajs/http-socket-client`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@spinajs/http-socket-client`, an isomorphic (browser + Node) socket.io client with a connection state machine, its own reconnect policy, handshake auth, plain commands with timeouts and cancellation, server events and typed contracts. W3 adds durable commands and W4 adds streams on top of it without rewrites.

**Architecture:** One `Connection` owns the socket.io `Socket` (state machine, handshake, reconnect, stop conditions). A `CommandDispatcher` sits on the `Connection` and implements plain commands. `SocketClient` composes them, routes server events, and is the only public class. W3's durable queue and W4's stream registry become two more consumers of the same `Connection` seams (`events.on('state')`, `connected`, `request`, `send`, `listen`). The wire types come from `@spinajs/http-socket-common`, which W1 also produces (see Task 1).

**Tech Stack:** TypeScript (ESM, `node16` resolution, dual mjs/cjs build), socket.io-client 4.8, socket.io 4.8 (tests only), mocha + chai + chai-as-promised + sinon through `ts-mocha`.

**Spec:** `docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md` (§4 wire protocol, §6 client, §8 plan W2).

## Global Constraints

- Work only in `C:\Users\grzch\SourceCodes\Spinajs\websocket-layer` (branch `feat/websocket-layer`). Never touch another Spinajs checkout or worktree (`main`, `authz-v3*`, … have in-flight work).
- The W1 executor works in this same worktree at the same time. Stage only the paths a step names (`git add <paths>`, never `git add -A` or `git add .`). Never `git stash`, `git reset`, `git checkout -- …` or `git clean`. Verify the branch in the same command as every commit: `git branch --show-current | grep -qx feat/websocket-layer && git commit …`.
- Never commit `package-lock.json`. `npm install` rewrites it; leave it modified. The branch integrator commits it once after W1 and W2 (CI runs `npm ci`, which fails on lock drift until then).
- Runtime dependencies of `@spinajs/http-socket-client`: `socket.io-client` (`^4.8.1`) and `@spinajs/http-socket-common` (`2.0.549`) **only**. No `@spinajs/di`, no other `@spinajs/*`. `socket.io` (`^4.8.1`) is a devDependency for the test stub server.
- The main entry runs in browsers: no Node built-in imports and no Node globals (`process`, `Buffer`, `require`, `__dirname`, `setImmediate`, `global`) anywhere in `src/`. Test `test/isomorphic.test.ts` (Task 2) enforces it.
- Binding defaults, verbatim from the spec: reconnect `{ minMs: 500, maxMs: 30_000, jitter: 0.3 }`; `defaultTimeoutMs: 15_000`; `whenOffline` default `'fail'`.
- Connection states, verbatim: `'connecting' | 'online' | 'offline' | 'closed'`; a `'state'` event fires on every change.
- Error codes, verbatim: `'invalid_argument' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'failed_precondition' | 'unimplemented' | 'deadline_exceeded' | 'cancelled' | 'resource_exhausted' | 'unavailable' | 'version_mismatch' | 'internal'`.
- Spec §6 behaviour, verbatim: auth is asked again on each attempt; `unauthenticated` stops the retries and emits `auth_required`; `version_mismatch` stops and emits `incompatible`; `sys.shutdown` waits `retryAfterMs` before the next attempt; offline + `whenOffline: 'fail'` rejects at once with `unavailable`; `'wait'` holds the command until online or the timeout; a drop in the middle of a command rejects it with `unavailable`, which is retryable.
- Reserved names (W3/W4 fill them, nothing else may use them): methods `durable()` and `stream()`, lifecycle event `failed`, option `outbox`, subpath export `./browser`.
- Handshake: `{ ...authCallbackResult, protocol: PROTOCOL_VERSION, clientId }` — `protocol` and `clientId` always win. Auth payload keys `pid` and `offset` are reserved by socket.io connection state recovery (it merges them into the CONNECT packet).
- Wire assumptions W2 makes where the spec is silent (Task 1 reconciles them with W1):
  - socket.io event names: commands `'cmd'` (ack carries the `CommandReply`), events `'evt'` (an `EventFrame`, both directions), plain-command cancel `'cancel'` with payload `{ id }`.
  - `CommandRequest.deadline` is the **remaining budget in milliseconds at send time** (relative, immune to clock skew), not an epoch timestamp.
  - `sys.shutdown` arrives as an `'evt'` frame `{ name: 'sys.shutdown', payload: { retryAfterMs } }`.
  - A refused handshake rejects with `connect_error` whose `data` is a `SocketError` (spec §4).
- Repo conventions: every package is `"type": "module"`, version `2.0.549` in lockstep with exact internal pins, dual build `tsconfig.mjs.json` → `lib/mjs` and `tsconfig.cjs.json` → `lib/cjs`, `tsconfig.json` (rootDir `./`, includes `test/`) for tests; relative imports end in `.js`.
- Packages consume each other through built `lib/mjs`, not `src`. After changing `packages/http-socket-common/src`, run `npm run compile` in `packages/http-socket-common` before running client tests.
- Run one test file from inside its package: `npx ts-mocha -p tsconfig.json test/<file>.test.ts`. The new packages' `.mocharc.json` has no `spec` entry on purpose: a `spec` there is concatenated with the CLI file and runs the whole suite. Type-level assertions are checked by `npm run typecheck` in the package (the test runner may transpile without type checking).
- On Windows a TCP connect to a closed localhost port takes about 2 s before it is refused, so timing assertions use handshake refusals, never a stopped server.
- Comments, identifiers and commit messages in English. Comment only what the code cannot say. Commits follow `feat(http-socket-client): …`, `feat(http-socket-common): …`, `test(…)`, `chore(…)`.

## File map

`packages/http-socket-common/` (Task 1; skipped if W1 already created it)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `.mocharc.json` | Package scaffold, no dependencies |
| `src/protocol.ts` | `PROTOCOL_VERSION`, `Handshake`, `CommandRequest`, `CommandReply`, `SocketError`, `ErrorCode`, `EventFrame`, `Chunk` (spec §4 verbatim) |
| `src/contract.ts` | `SocketContract`, `Contract`, `defineContract`, `CommandName`, `CommandPayload`, `CommandResult`, `EventName`, `EventPayload` |
| `src/index.ts` | Re-exports |
| `test/common.test.ts` | Runtime + type-level checks |

`packages/http-socket-client/`

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `.mocharc.json` | Package scaffold |
| `src/errors.ts` | `SocketCommandError`, `isSocketError` |
| `src/ids.ts` | `randomId()` for generated client ids |
| `src/emitter.ts` | Minimal typed `Emitter`, `rethrowAsync` |
| `src/reconnect.ts` | `ReconnectPolicy`, `DEFAULT_RECONNECT` |
| `src/wire.ts` | socket.io event names, `SYS_SHUTDOWN`, `ShutdownNotice` |
| `src/connection.ts` | `Connection`: socket ownership, state machine, handshake, reconnect, stop conditions |
| `src/commands.ts` | `CommandDispatcher`: plain commands, timeouts, cancellation, offline policy |
| `src/client.ts` | `SocketClient` facade, lifecycle and server events, reserved `durable()`/`stream()` |
| `src/contract.ts` | `TypedSocketClient`, `StreamItem` |
| `src/index.ts` | Public entry |
| `test/support/stub-server.ts` | socket.io server speaking §4, with fault injection (not the W1 server) |
| `test/support/cleanup.ts`, `wait.ts`, `connection.ts`, `commands.ts`, `client.ts` | Test helpers |
| `test/*.test.ts` | One file per unit/behaviour |

Root: `tsconfig.build.json`, `tsconfig.build.cjs.json` (references).

## Seams for W3 and W4 (design contract, no code in W2 beyond what the tasks list)

- `Connection` is the only owner of the socket. Consumers use: `events.on('state', (state, previous) => …)`, `connected`, `request(event, data, onReply)`, `send(event, ...args)`, `listen(event, handler)`. W3's `DurableQueue` and W4's `StreamRegistry` are new consumers; neither edits `Connection`.
- `Connection` clears socket.io's `sendBuffer` on every drop and disables socket.io packet retries, so nothing is re-sent behind the layer's back. W3's resend-after-drop (with `idempotencyKey = clientId:seq`) is therefore the only resend path.
- `CommandDispatcher.nextId()` is the single request-id space; W3 and W4 take ids from it.
- W3: add `outbox?: OutboxStore` to `SocketClientOptions`, replace the body of `SocketClient.durable()`, emit lifecycle `failed` (already typed as `{ entry: unknown; error: SocketError }`; W3 narrows `entry`), add the `./browser` export like `packages/configuration-common/package.json` does.
- W4: replace the body of `SocketClient.stream()`; route `{ ok: true, stream: true }` replies (today a plain command rejects them with `failed_precondition`) to the stream registry; frames via `connection.listen(WIRE.chunk | WIRE.end | WIRE.fail)`, flow control via `connection.send(WIRE.credit | WIRE.cancel, …)`. `TypedSocketClient.stream()` already types items through `StreamItem`.

---

### Task 1: `@spinajs/http-socket-common` (or reconcile with W1's)

**Files:**
- Create: `packages/http-socket-common/package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `.mocharc.json`
- Create: `packages/http-socket-common/src/protocol.ts`, `src/contract.ts`, `src/index.ts`
- Test: `packages/http-socket-common/test/common.test.ts`
- Modify: `tsconfig.build.json:66`, `tsconfig.build.cjs.json:66`

**Interfaces:**
- Consumes: nothing.
- Produces (exact names every later task imports from `@spinajs/http-socket-common`): `PROTOCOL_VERSION: number` (= 1); types `Handshake`, `CommandRequest`, `CommandReply`, `SocketError`, `ErrorCode`, `EventFrame`, `Chunk`, `SocketContract`, `Contract<C>`, `CommandName<C>`, `CommandPayload<C, N>`, `CommandResult<C, N>`, `EventName<C>`, `EventPayload<C, N>`; function `defineContract<C>(): Contract<C>`.

- [ ] **Step 0: Decide whether W1 got here first**

Run (worktree root): `ls packages/http-socket-common/package.json docs/superpowers/plans/`

- If `packages/http-socket-common/package.json` exists, W1 owns the package: skip Steps 1–8 and do Step 9 (reconcile) instead.
- Otherwise do Steps 1–8. W1 then adapts to this package (whichever lands first wins).

- [ ] **Step 1: Scaffold the package**

`packages/http-socket-common/package.json`:

```json
{
  "name": "@spinajs/http-socket-common",
  "version": "2.0.549",
  "description": "Wire protocol types and contract helpers shared by the spinajs socket server and client",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "sideEffects": false,
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit --composite false --incremental false",
    "coverage": "nyc npm run test"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "websocket",
    "socket.io"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme"
}
```

`packages/http-socket-common/tsconfig.json`:

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

`packages/http-socket-common/tsconfig.mjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"]
}
```

`packages/http-socket-common/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"]
}
```

`packages/http-socket-common/.mocharc.json`:

```json
{
  "extensions": ["ts"],
  "timeout": 10000,
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm"
  ]
}
```

- [ ] **Step 2: Install so the workspace is linked**

Run (worktree root): `npm install`
Expected: ends with `added … packages` / `up to date`, no `ERR!`. `ls node_modules/@spinajs/http-socket-common` lists `package.json`.

- [ ] **Step 3: Write the failing test**

`packages/http-socket-common/test/common.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import {
  PROTOCOL_VERSION,
  defineContract,
  type CommandName,
  type CommandPayload,
  type CommandReply,
  type CommandResult,
  type EventName,
  type EventPayload,
  type SocketError,
} from '../src/index.js';

type Sample = {
  commands: { 'a.run': [{ n: number }, string]; 'a.void': [{ n: number }, void] };
  events: { 'a.changed': boolean };
};

describe('http-socket-common', () => {
  it('speaks protocol 1', () => {
    expect(PROTOCOL_VERSION).to.equal(1);
  });

  it('defineContract() returns a frozen marker with no runtime data', () => {
    const contract = defineContract<Sample>();
    expect(Object.keys(contract)).to.deep.equal([]);
    expect(Object.isFrozen(contract)).to.equal(true);
  });
});

// Compile-time only; `npm run typecheck` fails if an expectation below stops holding.
function typeChecks(): void {
  const name: CommandName<Sample> = 'a.run';
  // @ts-expect-error not a command of Sample
  const unknownName: CommandName<Sample> = 'a.nope';
  const payload: CommandPayload<Sample, 'a.run'> = { n: 1 };
  const result: CommandResult<Sample, 'a.run'> = 'done';
  const nothing: CommandResult<Sample, 'a.void'> = undefined;
  const event: EventName<Sample> = 'a.changed';
  const eventPayload: EventPayload<Sample, 'a.changed'> = true;
  const reply: CommandReply = { id: '1', ok: false, error: { code: 'not_found', message: 'x', retryable: false } };
  // @ts-expect-error not an ErrorCode
  const wrongCode: SocketError = { code: 'nope', message: 'x', retryable: false };
  void [name, unknownName, payload, result, nothing, event, eventPayload, reply, wrongCode];
}
void typeChecks;
```

- [ ] **Step 4: Run it to verify it fails**

Run (in `packages/http-socket-common`): `npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (or TS2307) for `../src/index.js`.

- [ ] **Step 5: Implement**

`packages/http-socket-common/src/protocol.ts`:

```ts
export const PROTOCOL_VERSION = 1;

// handshake: io(url, { auth })
export interface Handshake {
  protocol: number;
  clientId: string;
  token?: string;
  [key: string]: unknown;
}

// command: client → server event 'cmd', answered through the socket.io ack
export interface CommandRequest {
  id: string;
  name: string;
  payload: unknown;
  idempotencyKey?: string;
  deadline?: number;
  traceparent?: string;
}

export type CommandReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: true; stream: true }
  | { id: string; ok: false; error: SocketError };

export interface SocketError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  retryable: boolean;
  retryAfterMs?: number;
  errorId?: string;
}

export type ErrorCode =
  | 'invalid_argument'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'failed_precondition'
  | 'unimplemented'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'resource_exhausted'
  | 'unavailable'
  | 'version_mismatch'
  | 'internal';

// event: either direction, 'evt'
export interface EventFrame {
  name: string;
  payload: unknown;
}

// stream reply: server → client 'chunk' | 'end' | 'fail'; client → server 'credit' | 'cancel'
export interface Chunk {
  id: string;
  seq: number;
  data: unknown;
}
```

`packages/http-socket-common/src/contract.ts`:

```ts
/** `commands` maps a name to `[payload, result]`; `events` maps a name to its payload. */
export interface SocketContract {
  commands: object;
  events: object;
}

/** Typing-only marker shared by the server and the client; it carries no runtime data. */
export interface Contract<C extends SocketContract> {
  readonly __contract?: C;
}

export function defineContract<C extends SocketContract>(): Contract<C> {
  return Object.freeze({}) as Contract<C>;
}

export type CommandName<C extends SocketContract> = Extract<keyof C['commands'], string>;

export type CommandPayload<C extends SocketContract, N extends CommandName<C>> = C['commands'][N] extends readonly [infer P, unknown] ? P : never;

export type CommandResult<C extends SocketContract, N extends CommandName<C>> = C['commands'][N] extends readonly [unknown, infer R] ? R : never;

export type EventName<C extends SocketContract> = Extract<keyof C['events'], string>;

export type EventPayload<C extends SocketContract, N extends EventName<C>> = C['events'][N];
```

`packages/http-socket-common/src/index.ts`:

```ts
export * from './protocol.js';
export * from './contract.js';
```

- [ ] **Step 6: Run the tests and the type check**

Run (in `packages/http-socket-common`): `npx ts-mocha -p tsconfig.json test/common.test.ts`
Expected: `2 passing`.

Run (in `packages/http-socket-common`): `npm run typecheck`
Expected: exits 0, no diagnostics.

- [ ] **Step 7: Wire the root build and compile**

In `tsconfig.build.json`, after line 66 (`    { "path": "packages/http-socket/tsconfig.mjs.json"},`) add, unless W1 already added it:

```json
    { "path": "packages/http-socket-common/tsconfig.mjs.json" },
```

In `tsconfig.build.cjs.json`, after line 66 (`    { "path": "packages/http-socket/tsconfig.cjs.json"},`) add, unless already present:

```json
    { "path": "packages/http-socket-common/tsconfig.cjs.json" },
```

Run (in `packages/http-socket-common`): `npm run compile`
Expected: exits 0; `lib/mjs/index.js` and `lib/mjs/index.d.ts` exist.

- [ ] **Step 8: Commit**

```bash
git add packages/http-socket-common/package.json packages/http-socket-common/tsconfig.json packages/http-socket-common/tsconfig.mjs.json packages/http-socket-common/tsconfig.cjs.json packages/http-socket-common/.mocharc.json packages/http-socket-common/src packages/http-socket-common/test tsconfig.build.json tsconfig.build.cjs.json docs/superpowers/specs/2026-10-02-spinajs-websocket-design.md docs/superpowers/plans/2026-10-02-ws-w2-client-core.md
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-common): wire protocol types and contract helpers"
```

- [ ] **Step 9 (only if W1 created the package): Reconcile**

1. Run (worktree root) `npm install`, then (in `packages/http-socket-common`) `npm run compile`.
2. Compare W1's exports with the **Produces** list above. For each missing or differently named item:
   - wire types (`Handshake`, `CommandRequest`, `CommandReply`, `SocketError`, `ErrorCode`, `EventFrame`, `Chunk`, `PROTOCOL_VERSION`): W1's names and shapes win. Change the imports in every later task of this plan to W1's names before executing it.
   - contract helpers (`SocketContract`, `Contract`, `defineContract`, `CommandName`, `CommandPayload`, `CommandResult`, `EventName`, `EventPayload`): if W1 has equivalents, use them and adjust Tasks 10–11. If not, add the missing ones to `packages/http-socket-common/src/contract.ts` exactly as in Step 5 (additive only, never rename W1's), plus the `typeChecks` block of Step 3 into W1's test file.
3. Compare W1's plan (`docs/superpowers/plans/2026-10-02-ws-w1-server-core.md`) with the **Wire assumptions** in Global Constraints (`'cmd'`, `'evt'`, `'cancel'` + `{ id }`, relative `deadline`, `sys.shutdown` as an `'evt'` frame, `connect_error.data`). Where W1 differs, W1 wins: change `src/wire.ts` (Task 5) and the deadline line in `src/commands.ts` (Task 8) accordingly and note it in the commit message.
4. Commit only what you changed in `packages/http-socket-common`, with message `feat(http-socket-common): contract helpers for the client` (skip if nothing changed). Also commit this plan file if it is untracked.

---

### Task 2: Client package scaffold, `SocketCommandError`, ids, isomorphic guard

**Files:**
- Create: `packages/http-socket-client/package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `.mocharc.json`
- Create: `packages/http-socket-client/src/errors.ts`, `src/ids.ts`
- Test: `packages/http-socket-client/test/errors.test.ts`, `test/ids.test.ts`, `test/isomorphic.test.ts`
- Modify: `tsconfig.build.json`, `tsconfig.build.cjs.json`

**Interfaces:**
- Consumes: `SocketError`, `ErrorCode` (Task 1).
- Produces: `class SocketCommandError extends Error { readonly error: SocketError; readonly command: string | undefined; get code(): ErrorCode; get retryable(): boolean; get retryAfterMs(): number | undefined; get details(): unknown; get errorId(): string | undefined }` with `constructor(error: SocketError, command?: string)`; `isSocketError(value: unknown): value is SocketError`; `randomId(source?: { randomUUID?: () => string }): string`.

- [ ] **Step 1: Scaffold the package**

`packages/http-socket-client/package.json`:

```json
{
  "name": "@spinajs/http-socket-client",
  "version": "2.0.549",
  "description": "Isomorphic socket client for spinajs: connection state, reconnect, commands, events, typed contracts",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "sideEffects": false,
  "private": false,
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit --composite false --incremental false",
    "coverage": "nyc npm run test"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "websocket",
    "socket.io",
    "client"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/http-socket-common": "2.0.549",
    "socket.io-client": "^4.8.1"
  },
  "devDependencies": {
    "socket.io": "^4.8.1"
  }
}
```

`packages/http-socket-client/tsconfig.json`:

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

`packages/http-socket-client/tsconfig.mjs.json`:

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
  "references": [{ "path": "../http-socket-common/tsconfig.mjs.json" }]
}
```

`packages/http-socket-client/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../http-socket-common/tsconfig.cjs.json" }]
}
```

`packages/http-socket-client/.mocharc.json`:

```json
{
  "extensions": ["ts"],
  "timeout": 10000,
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm"
  ]
}
```

In `tsconfig.build.json`, directly after the `http-socket-common` reference from Task 1, add:

```json
    { "path": "packages/http-socket-client/tsconfig.mjs.json" },
```

In `tsconfig.build.cjs.json`, directly after the `http-socket-common` reference, add:

```json
    { "path": "packages/http-socket-client/tsconfig.cjs.json" },
```

Run (worktree root): `npm install`
Expected: no `ERR!`; `ls node_modules/socket.io-client/package.json node_modules/socket.io/package.json node_modules/@spinajs/http-socket-client/package.json` lists all three.

- [ ] **Step 2: Write the failing tests**

`packages/http-socket-client/test/errors.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { SocketError } from '@spinajs/http-socket-common';
import { SocketCommandError, isSocketError } from '../src/errors.js';

describe('SocketCommandError', () => {
  it('carries the wire error and the command name', () => {
    const wire: SocketError = { code: 'resource_exhausted', message: 'slow down', retryable: true, retryAfterMs: 250, details: { limit: 10 }, errorId: 'e-1' };
    const error = new SocketCommandError(wire, 'docs.open');

    expect(error).to.be.instanceOf(Error);
    expect(error).to.be.instanceOf(SocketCommandError);
    expect(error.name).to.equal('SocketCommandError');
    expect(error.message).to.equal('docs.open: slow down');
    expect(error.command).to.equal('docs.open');
    expect(error.error).to.equal(wire);
    expect([error.code, error.retryable, error.retryAfterMs, error.errorId]).to.deep.equal(['resource_exhausted', true, 250, 'e-1']);
    expect(error.details).to.deep.equal({ limit: 10 });
  });

  it('uses the bare message when there is no command name', () => {
    const error = new SocketCommandError({ code: 'internal', message: 'boom', retryable: false });
    expect(error.message).to.equal('boom');
    expect(error.command).to.equal(undefined);
  });
});

describe('isSocketError', () => {
  it('accepts the wire shape, including codes this client does not know', () => {
    expect(isSocketError({ code: 'not_found', message: 'x', retryable: false })).to.equal(true);
    expect(isSocketError({ code: 'from_a_newer_server', message: 'x', retryable: true })).to.equal(true);
  });

  it('rejects anything else', () => {
    for (const value of [null, undefined, 'x', 42, {}, { code: 'x', message: 'y' }, { code: 1, message: 'y', retryable: false }]) {
      expect(isSocketError(value), JSON.stringify(value)).to.equal(false);
    }
  });
});
```

`packages/http-socket-client/test/ids.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { randomId } from '../src/ids.js';

describe('randomId', () => {
  it('uses crypto.randomUUID when the platform has it', () => {
    expect(randomId({ randomUUID: () => 'fixed-uuid' })).to.equal('fixed-uuid');
    expect(randomId()).to.match(/^[0-9a-f-]{36}$/);
  });

  it('falls back to unique Math.random ids without randomUUID', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId({})));
    expect(ids.size).to.equal(200);
    for (const id of ids) expect(id).to.match(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
  });
});
```

`packages/http-socket-client/test/isomorphic.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { builtinModules } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED_PACKAGES = ['@spinajs/http-socket-common', 'socket.io-client'];
const NODE_GLOBAL = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate|global)\s*[.(]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)) {
    found.push(match[1] ?? match[2]);
  }
  return found;
}

describe('isomorphic main entry', () => {
  it('declares only socket.io-client and http-socket-common as runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).to.deep.equal(ALLOWED_PACKAGES);
  });

  it('src imports only relative modules and the allowed packages, and uses no Node globals', () => {
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const files = sourceFiles(join(packageDir, 'src'));
    expect(files).to.not.be.empty;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiers(source)) {
        expect(builtins.has(specifier), `${file} imports Node built-in ${specifier}`).to.equal(false);
        expect(specifier.startsWith('.') || ALLOWED_PACKAGES.includes(specifier), `${file} imports ${specifier}`).to.equal(true);
      }
      expect(NODE_GLOBAL.test(source), `${file} uses a Node global`).to.equal(false);
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/errors.test.ts test/ids.test.ts test/isomorphic.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/errors.js` / `../src/ids.js` (and `ENOENT` for `src` in the isomorphic test).

- [ ] **Step 4: Implement**

`packages/http-socket-client/src/errors.ts`:

```ts
import type { ErrorCode, SocketError } from '@spinajs/http-socket-common';

/** Rejection of a command; `error` is the wire `SocketError` unchanged. */
export class SocketCommandError extends Error {
  public readonly error: SocketError;
  public readonly command: string | undefined;

  constructor(error: SocketError, command?: string) {
    super(command === undefined ? error.message : `${command}: ${error.message}`);
    this.name = 'SocketCommandError';
    this.error = error;
    this.command = command;
  }

  public get code(): ErrorCode {
    return this.error.code;
  }

  public get retryable(): boolean {
    return this.error.retryable;
  }

  public get retryAfterMs(): number | undefined {
    return this.error.retryAfterMs;
  }

  public get details(): unknown {
    return this.error.details;
  }

  public get errorId(): string | undefined {
    return this.error.errorId;
  }
}

/** Shape check only, so codes from a newer server still pass. */
export function isSocketError(value: unknown): value is SocketError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string' && typeof candidate.retryable === 'boolean';
}
```

`packages/http-socket-client/src/ids.ts`:

```ts
interface UuidSource {
  randomUUID?: () => string;
}

/** crypto.randomUUID is missing in insecure (plain http) browser contexts, hence the fallback. */
export function randomId(source: UuidSource | undefined = (globalThis as { crypto?: UuidSource }).crypto): string {
  if (source?.randomUUID) return source.randomUUID();
  const part = (): string => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${part()}-${part()}-${part()}`;
}
```

- [ ] **Step 5: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/errors.test.ts test/ids.test.ts test/isomorphic.test.ts`
Expected: `8 passing`.

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/http-socket-client/package.json packages/http-socket-client/tsconfig.json packages/http-socket-client/tsconfig.mjs.json packages/http-socket-client/tsconfig.cjs.json packages/http-socket-client/.mocharc.json packages/http-socket-client/src/errors.ts packages/http-socket-client/src/ids.ts packages/http-socket-client/test/errors.test.ts packages/http-socket-client/test/ids.test.ts packages/http-socket-client/test/isomorphic.test.ts tsconfig.build.json tsconfig.build.cjs.json
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): package scaffold, SocketCommandError and the isomorphic guard"
```

---

### Task 3: Typed `Emitter`

**Files:**
- Create: `packages/http-socket-client/src/emitter.ts`
- Test: `packages/http-socket-client/test/emitter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Emitter<E extends ListenerMap<E>>` with `constructor(onListenerError?: (error: unknown) => void)`, `on(event, listener): () => void`, `once(event, listener): () => void`, `off(event, listener): void`, `emit(event, ...args): void`, `listenerCount(event): number`, `clear(): void`; `type ListenerMap<E>`; `rethrowAsync(error: unknown): void`.

- [ ] **Step 1: Write the failing test**

`packages/http-socket-client/test/emitter.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Emitter, rethrowAsync } from '../src/emitter.js';

interface TestEvents {
  tick: (n: number) => void;
  pair: (a: string, b: number) => void;
}

describe('Emitter', () => {
  it('calls listeners in registration order with the emitted arguments', () => {
    const emitter = new Emitter<TestEvents>();
    const calls: string[] = [];
    emitter.on('pair', (a, b) => calls.push(`first ${a} ${b}`));
    emitter.on('pair', (a, b) => calls.push(`second ${a} ${b}`));

    emitter.emit('pair', 'x', 1);

    expect(calls).to.deep.equal(['first x 1', 'second x 1']);
  });

  it('on() returns an unsubscribe function', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: number[] = [];
    const unsubscribe = emitter.on('tick', (n) => seen.push(n));

    emitter.emit('tick', 1);
    unsubscribe();
    emitter.emit('tick', 2);

    expect(seen).to.deep.equal([1]);
    expect(emitter.listenerCount('tick')).to.equal(0);
  });

  it('off() removes a listener', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: number[] = [];
    const listener = (n: number): void => {
      seen.push(n);
    };
    emitter.on('tick', listener);

    emitter.off('tick', listener);
    emitter.emit('tick', 1);

    expect(seen).to.deep.equal([]);
  });

  it('once() fires a single time, and off() with the original listener removes it before it fires', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: number[] = [];
    emitter.once('tick', (n) => seen.push(n));
    emitter.emit('tick', 1);
    emitter.emit('tick', 2);
    expect(seen).to.deep.equal([1]);

    const listener = (n: number): void => {
      seen.push(n * 10);
    };
    emitter.once('tick', listener);
    emitter.off('tick', listener);
    emitter.emit('tick', 3);

    expect(seen).to.deep.equal([1]);
  });

  it('reports a throwing listener and still calls the others', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter<TestEvents>((error) => errors.push(error));
    const seen: number[] = [];
    emitter.on('tick', () => {
      throw new Error('boom');
    });
    emitter.on('tick', (n) => seen.push(n));

    emitter.emit('tick', 7);

    expect(seen).to.deep.equal([7]);
    expect(errors).to.have.length(1);
    expect((errors[0] as Error).message).to.equal('boom');
  });

  it('rethrowAsync() surfaces the error on a later tick, not in the caller', () => {
    const clock = sinon.useFakeTimers();
    try {
      expect(() => rethrowAsync(new Error('later'))).to.not.throw();
      expect(() => clock.tick(1)).to.throw('later');
    } finally {
      clock.restore();
    }
  });

  it('listenerCount() counts per event and clear() drops everything', () => {
    const emitter = new Emitter<TestEvents>();
    emitter.on('tick', () => undefined);
    emitter.on('tick', () => undefined);
    emitter.on('pair', () => undefined);
    expect(emitter.listenerCount('tick')).to.equal(2);
    expect(emitter.listenerCount('pair')).to.equal(1);

    emitter.clear();

    expect(emitter.listenerCount('tick')).to.equal(0);
    expect(emitter.listenerCount('pair')).to.equal(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/emitter.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/emitter.js`.

- [ ] **Step 3: Implement**

`packages/http-socket-client/src/emitter.ts`:

```ts
type Listener = (...args: any[]) => void;
type Registered = Listener & { original?: Listener };
type Args<F> = F extends (...args: infer A) => void ? A : never;

export type ListenerMap<E> = { [K in keyof E]: (...args: any[]) => void };

/** A minimal typed emitter; `node:events` is not available in browsers. */
export class Emitter<E extends ListenerMap<E>> {
  private readonly listeners = new Map<keyof E, Set<Registered>>();

  constructor(private readonly onListenerError: (error: unknown) => void = rethrowAsync) {}

  public on<K extends keyof E>(event: K, listener: E[K]): () => void {
    return this.add(event, listener as Registered);
  }

  public once<K extends keyof E>(event: K, listener: E[K]): () => void {
    const wrapper: Registered = (...args: unknown[]) => {
      this.remove(event, wrapper);
      (listener as Listener)(...args);
    };
    wrapper.original = listener as Listener;
    return this.add(event, wrapper);
  }

  public off<K extends keyof E>(event: K, listener: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const registered of set) {
      if (registered === listener || registered.original === listener) set.delete(registered);
    }
    if (set.size === 0) this.listeners.delete(event);
  }

  public emit<K extends keyof E>(event: K, ...args: Args<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  public listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  public clear(): void {
    this.listeners.clear();
  }

  private add(event: keyof E, listener: Registered): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.remove(event, listener);
  }

  private remove(event: keyof E, listener: Registered): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(event);
  }
}

/** Surfaces a listener error as an uncaught error without breaking the code path that emitted. */
export function rethrowAsync(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/emitter.test.ts`
Expected: `7 passing`.

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/emitter.ts packages/http-socket-client/test/emitter.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): typed isomorphic emitter"
```

---

### Task 4: `ReconnectPolicy`

**Decision recorded here (the "why" for Tasks 6 and later):** the client runs its **own** reconnect policy and sets socket.io's `reconnection: false`. socket.io's Manager reconnects only after engine-level failures: it does not retry a handshake refused by middleware (`connect_error` with `data`) nor an `io server disconnect`, and its backoff cannot take a per-attempt floor such as `sys.shutdown`'s or a refusal's `retryAfterMs`. One policy in `Connection` covers all three cases, owns the state machine, and is unit-testable with an injected random source. The same `Socket` instance is reused for every attempt, so socket.io connection state recovery (its `pid`/`offset`) keeps working.

Policy: `delay(attempt) = round(min(maxMs, minMs · 2^attempt) · (1 − jitter · random))` — jitter only shortens, so `maxMs` is a hard ceiling. With a server hint: `max(delay, round(retryAfterMs · (1 + jitter · random)))` — the hint is a floor, spread upwards so clients told the same `retryAfterMs` do not return together.

**Files:**
- Create: `packages/http-socket-client/src/reconnect.ts`
- Test: `packages/http-socket-client/test/reconnect-policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ReconnectOptions { minMs: number; maxMs: number; jitter: number }`; `DEFAULT_RECONNECT: Readonly<ReconnectOptions>`; `class ReconnectPolicy { constructor(options?: Partial<ReconnectOptions>, random?: () => number); readonly options: Readonly<ReconnectOptions>; delay(attempt: number, retryAfterMs?: number): number }`.

- [ ] **Step 1: Write the failing test**

`packages/http-socket-client/test/reconnect-policy.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DEFAULT_RECONNECT, ReconnectPolicy } from '../src/reconnect.js';

const fixed = (value: number) => (): number => value;

describe('ReconnectPolicy', () => {
  it('defaults to minMs 500, maxMs 30000, jitter 0.3', () => {
    expect(DEFAULT_RECONNECT).to.deep.equal({ minMs: 500, maxMs: 30_000, jitter: 0.3 });
    expect(new ReconnectPolicy().options).to.deep.equal(DEFAULT_RECONNECT);
  });

  it('doubles from minMs and caps at maxMs', () => {
    const policy = new ReconnectPolicy({}, fixed(0));
    expect([0, 1, 2, 5, 6, 50].map((attempt) => policy.delay(attempt))).to.deep.equal([500, 1000, 2000, 16_000, 30_000, 30_000]);
  });

  it('jitter only shortens a delay, by at most the jitter fraction', () => {
    expect(new ReconnectPolicy({}, fixed(1)).delay(0)).to.equal(350);
    expect(new ReconnectPolicy({}, fixed(1)).delay(6)).to.equal(21_000);
    expect(new ReconnectPolicy({}, fixed(0.5)).delay(0)).to.equal(425);
  });

  it('treats retryAfterMs as a floor spread upwards by the jitter', () => {
    expect(new ReconnectPolicy({}, fixed(0)).delay(0, 5000)).to.equal(5000);
    expect(new ReconnectPolicy({}, fixed(1)).delay(0, 5000)).to.equal(6500);
  });

  it('keeps the exponential delay when it is longer than retryAfterMs', () => {
    expect(new ReconnectPolicy({}, fixed(0)).delay(3, 100)).to.equal(4000);
  });

  it('rejects invalid options', () => {
    expect(() => new ReconnectPolicy({ minMs: -1 })).to.throw(RangeError);
    expect(() => new ReconnectPolicy({ minMs: 100, maxMs: 50 })).to.throw(RangeError);
    expect(() => new ReconnectPolicy({ jitter: 1.5 })).to.throw(RangeError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/reconnect-policy.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/reconnect.js`.

- [ ] **Step 3: Implement**

`packages/http-socket-client/src/reconnect.ts`:

```ts
export interface ReconnectOptions {
  minMs: number;
  maxMs: number;
  /** Fraction in [0, 1] by which a delay is randomly varied. */
  jitter: number;
}

export const DEFAULT_RECONNECT: Readonly<ReconnectOptions> = Object.freeze({ minMs: 500, maxMs: 30_000, jitter: 0.3 });

export class ReconnectPolicy {
  public readonly options: Readonly<ReconnectOptions>;

  constructor(options: Partial<ReconnectOptions> = {}, private readonly random: () => number = Math.random) {
    const merged = { ...DEFAULT_RECONNECT, ...options };
    if (!(merged.minMs >= 0)) throw new RangeError(`reconnect.minMs must be >= 0, got ${merged.minMs}`);
    if (!(merged.maxMs >= merged.minMs)) throw new RangeError(`reconnect.maxMs must be >= minMs, got ${merged.maxMs}`);
    if (!(merged.jitter >= 0 && merged.jitter <= 1)) throw new RangeError(`reconnect.jitter must be within [0, 1], got ${merged.jitter}`);
    this.options = Object.freeze(merged);
  }

  /**
   * Delay before retry `attempt` (0 = the first retry after a failure). Jitter only shortens the
   * exponential delay, so maxMs is a hard ceiling. A server hint is a floor, spread upwards so that
   * clients told the same retryAfterMs do not all come back at once.
   */
  public delay(attempt: number, retryAfterMs?: number): number {
    const { minMs, maxMs, jitter } = this.options;
    const exponential = Math.min(maxMs, minMs * 2 ** attempt);
    const backoff = Math.round(exponential * (1 - jitter * this.random()));
    if (retryAfterMs === undefined || retryAfterMs <= 0) return backoff;
    return Math.max(backoff, Math.round(retryAfterMs * (1 + jitter * this.random())));
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/reconnect-policy.test.ts`
Expected: `6 passing`.

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/reconnect.ts packages/http-socket-client/test/reconnect-policy.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): reconnect policy with exponential backoff, jitter and server hints"
```

---

### Task 5: Stub server and `Connection` core

**Files:**
- Create: `packages/http-socket-client/src/wire.ts`, `src/connection.ts`
- Create: `packages/http-socket-client/test/support/stub-server.ts`, `test/support/cleanup.ts`, `test/support/wait.ts`, `test/support/connection.ts`
- Test: `packages/http-socket-client/test/connection.test.ts`

**Interfaces:**
- Consumes: `Emitter` (Task 3); `PROTOCOL_VERSION`, `Handshake`, `CommandRequest`, `CommandReply`, `EventFrame`, `SocketError` (Task 1); `isSocketError` (Task 2).
- Produces:
  - `src/wire.ts`: `WIRE = { command: 'cmd', event: 'evt', cancel: 'cancel', chunk: 'chunk', end: 'end', fail: 'fail', credit: 'credit' } as const`; `SYS_SHUTDOWN = 'sys.shutdown'`; `interface ShutdownNotice { retryAfterMs: number }`.
  - `src/connection.ts`: `type ConnectionState = 'connecting' | 'online' | 'offline' | 'closed'`; `interface AuthPayload { token?: string; [key: string]: unknown }`; `type AuthProvider = () => AuthPayload | Promise<AuthPayload>`; `type IoOptions = Partial<ManagerOptions & SocketOptions>`; `interface ConnectionOptions { url; path?; clientId; auth?; io?; onListenerError? }` (Task 6 adds `reconnect?`, `connectTimeoutMs?`); `interface ConnectionEvents { state(state, previous) }` (Task 6 adds `auth_required`, `incompatible`); `class Connection { readonly events: Emitter<ConnectionEvents>; get state(): ConnectionState; get connected(): boolean; connect(): void; disconnect(): void; close(): void; send(event: string, ...args: unknown[]): boolean; request<R>(event: string, data: unknown, onReply: (reply: R) => void): boolean; listen(event: string, handler: (...args: any[]) => void): () => void }`.
  - Test support: `StubServer` (`start(port?)`, `stop()`, `restart(downMs?)`, `killConnections()`, `emitEvent(name, payload)`, `announceShutdown(retryAfterMs)`, `url`, `port`, `connectionCount`, `handshakes`, `requests`, `cancels`, `clientEvents`, `handlers`, `rawReplies`, `refuse`, `holdHandshakes`, `ackFault`); `track()`, `closeAll()`; `sleep()`, `until()`, `nextEmit()`, `Stateful`, `waitForState()`, `recordStates()`, `retryGaps()`, `StateRecord`; `FAST_RECONNECT`, `makeConnection()`, `statefulConnection()`.

- [ ] **Step 1: Write the test support**

`packages/http-socket-client/test/support/stub-server.ts`:

```ts
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import { PROTOCOL_VERSION, type CommandReply, type CommandRequest, type EventFrame, type Handshake, type SocketError } from '@spinajs/http-socket-common';
import { isSocketError } from '../../src/errors.js';

export type CommandHandler = (payload: any, request: CommandRequest, socket: Socket) => unknown;
export type RawReply = (request: CommandRequest) => unknown;
export type AckFault = { kind: 'none' } | { kind: 'drop' } | { kind: 'delay'; ms: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket.io server that speaks the spec §4 wire protocol, with fault injection. Not the W1 server. */
export class StubServer {
  public port = 0;
  public readonly handshakes: Handshake[] = [];
  public readonly requests: CommandRequest[] = [];
  public readonly cancels: string[] = [];
  public readonly clientEvents: EventFrame[] = [];
  public readonly handlers = new Map<string, CommandHandler>();
  public readonly rawReplies = new Map<string, RawReply>();
  public refuse: ((handshake: Handshake) => SocketError | undefined) | undefined;
  public holdHandshakes = false;
  public ackFault: AckFault = { kind: 'none' };
  private io: Server | undefined;
  private http: HttpServer | undefined;

  public get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public get connectionCount(): number {
    return this.io ? this.io.sockets.sockets.size : 0;
  }

  public async start(port = this.port): Promise<void> {
    const http = createServer();
    const io = new Server(http);

    io.use((socket, next) => {
      const handshake = socket.handshake.auth as Handshake;
      this.handshakes.push(handshake);
      if (this.holdHandshakes) return;
      const refusal: SocketError | undefined =
        handshake.protocol !== PROTOCOL_VERSION ? { code: 'version_mismatch', message: `server speaks protocol ${PROTOCOL_VERSION}`, retryable: false } : this.refuse?.(handshake);
      if (refusal) {
        const error = new Error(refusal.message) as Error & { data?: SocketError };
        error.data = refusal;
        next(error);
        return;
      }
      next();
    });

    io.on('connection', (socket) => {
      socket.on('cmd', (request: CommandRequest, ack: (reply: unknown) => void) => {
        this.requests.push(request);
        void this.reply(request, socket, ack);
      });
      socket.on('cancel', (message: { id: string }) => {
        this.cancels.push(message.id);
      });
      socket.on('evt', (frame: EventFrame) => {
        this.clientEvents.push(frame);
      });
    });

    await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', () => resolve()));
    this.port = (http.address() as AddressInfo).port;
    this.http = http;
    this.io = io;
  }

  public async stop(): Promise<void> {
    const io = this.io;
    if (!io) return;
    this.io = undefined;
    this.http = undefined;
    await new Promise<void>((resolve) => {
      void io.close(() => resolve());
    });
  }

  public async restart(downMs = 0): Promise<void> {
    const port = this.port;
    await this.stop();
    if (downMs > 0) await sleep(downMs);
    await this.start(port);
  }

  /** Kills every engine.io connection without a socket.io DISCONNECT, as a network drop would. */
  public killConnections(): void {
    for (const socket of this.io?.sockets.sockets.values() ?? []) socket.conn.close();
  }

  public emitEvent(name: string, payload: unknown): void {
    const frame: EventFrame = { name, payload };
    this.io?.emit('evt', frame);
  }

  public announceShutdown(retryAfterMs: number): void {
    this.emitEvent('sys.shutdown', { retryAfterMs });
  }

  private async reply(request: CommandRequest, socket: Socket, ack: (reply: unknown) => void): Promise<void> {
    const reply = await this.buildReply(request, socket);
    const fault = this.ackFault;
    if (fault.kind === 'drop') return;
    if (fault.kind === 'delay') await sleep(fault.ms);
    ack(reply);
  }

  private async buildReply(request: CommandRequest, socket: Socket): Promise<unknown> {
    const raw = this.rawReplies.get(request.name);
    if (raw) return raw(request);

    const handler = this.handlers.get(request.name);
    if (!handler) {
      const unknown: CommandReply = { id: request.id, ok: false, error: { code: 'unimplemented', message: `unknown command ${request.name}`, retryable: false } };
      return unknown;
    }
    try {
      const done: CommandReply = { id: request.id, ok: true, result: await handler(request.payload, request, socket) };
      return done;
    } catch (error) {
      const failed: CommandReply = { id: request.id, ok: false, error: isSocketError(error) ? error : { code: 'internal', message: 'handler failed', retryable: false } };
      return failed;
    }
  }
}
```

`packages/http-socket-client/test/support/cleanup.ts`:

```ts
const open: Array<{ close(): void }> = [];

export function track<T extends { close(): void }>(closable: T): T {
  open.push(closable);
  return closable;
}

export function closeAll(): void {
  for (const closable of open.splice(0)) closable.close();
}
```

`packages/http-socket-client/test/support/wait.ts`:

```ts
import type { ConnectionState } from '../../src/connection.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(predicate: () => boolean, timeoutMs = 5000, stepMs = 5): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

/** Resolves with the arguments of the next emit. Subscribe before triggering the event. */
export function nextEmit<A extends unknown[]>(subscribe: (listener: (...args: A) => void) => () => void, timeoutMs = 5000): Promise<A> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no emit within ${timeoutMs} ms`));
    }, timeoutMs);
    unsubscribe = subscribe((...args) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(args);
    });
  });
}

export interface Stateful {
  readonly state: ConnectionState;
  onState(listener: (state: ConnectionState, previous: ConnectionState) => void): () => void;
}

export function waitForState(target: Stateful, wanted: ConnectionState, timeoutMs = 5000): Promise<void> {
  if (target.state === wanted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`state '${wanted}' not reached within ${timeoutMs} ms (still '${target.state}')`));
    }, timeoutMs);
    unsubscribe = target.onState((state) => {
      if (state !== wanted) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

export interface StateRecord {
  state: ConnectionState;
  at: number;
}

export function recordStates(target: Stateful): StateRecord[] {
  const records: StateRecord[] = [];
  target.onState((state) => records.push({ state, at: Date.now() }));
  return records;
}

/** Milliseconds from each 'offline' to the 'connecting' that follows it: the scheduled retry delays. */
export function retryGaps(records: StateRecord[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < records.length; i++) {
    if (records[i - 1].state === 'offline' && records[i].state === 'connecting') gaps.push(records[i].at - records[i - 1].at);
  }
  return gaps;
}
```

`packages/http-socket-client/test/support/connection.ts`:

```ts
import { Connection, type ConnectionOptions } from '../../src/connection.js';
import { track } from './cleanup.js';
import type { StubServer } from './stub-server.js';
import type { Stateful } from './wait.js';

/** Retries after 20, 40, 80, 100, 100 … ms; no jitter, so timings are exact. */
export const FAST_RECONNECT = { minMs: 20, maxMs: 100, jitter: 0 };

export function makeConnection(server: StubServer, overrides: Partial<ConnectionOptions> = {}): Connection {
  return track(new Connection({ url: server.url, clientId: 'client-1', reconnect: FAST_RECONNECT, io: { transports: ['websocket'] }, ...overrides } as ConnectionOptions));
}

export function statefulConnection(connection: Connection): Stateful {
  return {
    get state() {
      return connection.state;
    },
    onState: (listener) => connection.events.on('state', listener),
  };
}
```

The `as ConnectionOptions` cast lets the helper pass `reconnect` before Task 6 adds it to `ConnectionOptions`; leave it in place afterwards.

- [ ] **Step 2: Write the failing test**

`packages/http-socket-client/test/connection.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { PROTOCOL_VERSION } from '@spinajs/http-socket-common';
import { WIRE } from '../src/wire.js';
import { closeAll } from './support/cleanup.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { recordStates, sleep, until, waitForState } from './support/wait.js';

describe('Connection', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('starts offline and goes connecting → online on connect()', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const states = recordStates(target);
    expect(connection.state).to.equal('offline');

    connection.connect();

    expect(connection.state).to.equal('connecting');
    await waitForState(target, 'online');
    expect(states.map((record) => record.state)).to.deep.equal(['connecting', 'online']);
    expect(connection.connected).to.equal(true);
  });

  it('sends the handshake {protocol, clientId, token} built from the auth callback', async () => {
    const connection = makeConnection(server, { clientId: 'install-42', auth: async () => ({ token: 'secret', locale: 'pl' }) });

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(server.handshakes).to.deep.equal([{ token: 'secret', locale: 'pl', protocol: PROTOCOL_VERSION, clientId: 'install-42' }]);
  });

  it('never lets the auth callback override protocol or clientId', async () => {
    const connection = makeConnection(server, { clientId: 'install-42', auth: () => ({ token: 't', protocol: 99, clientId: 'someone-else' }) });

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(server.handshakes[0]).to.deep.equal({ token: 't', protocol: PROTOCOL_VERSION, clientId: 'install-42' });
  });

  it('close() is terminal: state closed, socket released, connect() throws', async () => {
    const connection = makeConnection(server);
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    connection.close();

    expect(connection.state).to.equal('closed');
    await until(() => server.connectionCount === 0);
    expect(() => connection.connect()).to.throw('the client is closed');
  });

  it('disconnect() goes offline and stays there until connect()', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');
    const before = server.handshakes.length;

    connection.disconnect();

    expect(connection.state).to.equal('offline');
    await sleep(150);
    expect(connection.state).to.equal('offline');
    expect(server.handshakes).to.have.length(before);

    connection.connect();
    await waitForState(target, 'online');
    expect(server.handshakes).to.have.length(before + 1);
  });

  it('send() and listen() carry raw socket.io events; send() refuses while offline', async () => {
    const connection = makeConnection(server);
    expect(connection.send(WIRE.event, { name: 'early', payload: 0 })).to.equal(false);
    const received: unknown[] = [];
    const stopListening = connection.listen(WIRE.event, (frame) => received.push(frame));
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(connection.send(WIRE.event, { name: 'hello', payload: 1 })).to.equal(true);
    await until(() => server.clientEvents.length === 1);
    expect(server.clientEvents).to.deep.equal([{ name: 'hello', payload: 1 }]);

    server.emitEvent('docs.committed', { rev: 2 });
    await until(() => received.length === 1);
    expect(received).to.deep.equal([{ name: 'docs.committed', payload: { rev: 2 } }]);

    stopListening();
    server.emitEvent('docs.committed', { rev: 3 });
    await sleep(50);
    expect(received).to.have.length(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/connection.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/wire.js` / `../../src/connection.js`.

- [ ] **Step 4: Implement**

`packages/http-socket-client/src/wire.ts`:

```ts
/** socket.io event names of the spec §4 wire protocol. */
export const WIRE = {
  command: 'cmd',
  event: 'evt',
  cancel: 'cancel',
  chunk: 'chunk',
  end: 'end',
  fail: 'fail',
  credit: 'credit',
} as const;

export const SYS_SHUTDOWN = 'sys.shutdown';

export interface ShutdownNotice {
  retryAfterMs: number;
}
```

`packages/http-socket-client/src/connection.ts` (core; Task 6 replaces it with the resilient version):

```ts
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { PROTOCOL_VERSION, type Handshake } from '@spinajs/http-socket-common';
import { Emitter } from './emitter.js';

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'closed';

export interface AuthPayload {
  token?: string;
  [key: string]: unknown;
}

export type AuthProvider = () => AuthPayload | Promise<AuthPayload>;

export type IoOptions = Partial<ManagerOptions & SocketOptions>;

export interface ConnectionOptions {
  url: string;
  path?: string;
  clientId: string;
  auth?: AuthProvider;
  io?: IoOptions;
  onListenerError?: (error: unknown) => void;
}

export interface ConnectionEvents {
  state: (state: ConnectionState, previous: ConnectionState) => void;
}

export class Connection {
  public readonly events: Emitter<ConnectionEvents>;
  private readonly socket: Socket;
  private current: ConnectionState = 'offline';
  private attemptId = 0;

  constructor(private readonly options: ConnectionOptions) {
    this.events = new Emitter<ConnectionEvents>(options.onListenerError);
    this.socket = io(options.url, {
      ...options.io,
      ...(options.path !== undefined ? { path: options.path } : {}),
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      retries: 0,
      auth: (cb: (data: object) => void) => this.provideAuth(cb),
    });
    this.socket.on('connect', () => this.setState('online'));
    this.socket.on('connect_error', () => this.setState('offline'));
    this.socket.on('disconnect', () => {
      if (this.current !== 'closed') this.setState('offline');
    });
  }

  public get state(): ConnectionState {
    return this.current;
  }

  public get connected(): boolean {
    return this.current === 'online' && this.socket.connected;
  }

  public connect(): void {
    if (this.current === 'closed') throw new Error('the client is closed');
    if (this.current !== 'offline') return;
    this.open();
  }

  public disconnect(): void {
    if (this.current === 'closed') return;
    this.abortAttempt();
    this.setState('offline');
  }

  public close(): void {
    if (this.current === 'closed') return;
    this.setState('closed');
    this.abortAttempt();
  }

  public send(event: string, ...args: unknown[]): boolean {
    if (!this.connected) return false;
    this.socket.emit(event, ...args);
    return true;
  }

  public request<R>(event: string, data: unknown, onReply: (reply: R) => void): boolean {
    if (!this.connected) return false;
    this.socket.emit(event, data, onReply);
    return true;
  }

  public listen(event: string, handler: (...args: any[]) => void): () => void {
    this.socket.on(event, handler);
    return () => {
      this.socket.off(event, handler);
    };
  }

  private open(): void {
    this.attemptId++;
    this.setState('connecting');
    this.socket.connect();
  }

  private provideAuth(cb: (data: object) => void): void {
    const attemptId = this.attemptId;
    Promise.resolve()
      .then(() => this.options.auth?.())
      .then(
        (extra) => {
          if (attemptId !== this.attemptId) return;
          const handshake: Handshake = { ...extra, protocol: PROTOCOL_VERSION, clientId: this.options.clientId };
          cb(handshake);
        },
        () => {
          if (attemptId !== this.attemptId) return;
          this.abortAttempt();
          this.setState('offline');
        },
      );
  }

  private abortAttempt(): void {
    this.attemptId++;
    this.socket.disconnect();
  }

  private setState(next: ConnectionState): void {
    if (this.current === next) return;
    const previous = this.current;
    this.current = next;
    this.events.emit('state', next, previous);
  }
}
```

- [ ] **Step 5: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/connection.test.ts`
Expected: `6 passing`.

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/http-socket-client/src/wire.ts packages/http-socket-client/src/connection.ts packages/http-socket-client/test/support packages/http-socket-client/test/connection.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): connection state machine and handshake, with a protocol stub server for tests"
```

---

### Task 6: `Connection` resilience: reconnect, server hints, stop conditions

**Files:**
- Modify (full replacement): `packages/http-socket-client/src/connection.ts`
- Test: `packages/http-socket-client/test/connection-resilience.test.ts`, `test/handshake-errors.test.ts`

**Interfaces:**
- Consumes: `ReconnectPolicy`, `ReconnectOptions` (Task 4); `WIRE`, `SYS_SHUTDOWN`, `ShutdownNotice` (Task 5); `isSocketError` (Task 2); test support (Task 5).
- Produces (additions to Task 5's surface): `ConnectionOptions.reconnect?: Partial<ReconnectOptions>`, `ConnectionOptions.connectTimeoutMs?: number`; `ConnectionEvents.auth_required(error: SocketError)`, `ConnectionEvents.incompatible(error: SocketError)`; `DEFAULT_CONNECT_TIMEOUT_MS = 20_000`.

Behaviour this task adds:
- Every failure (engine error, refused handshake, drop, unanswered handshake) schedules a retry through `ReconnectPolicy`; attempts reset after `online` and on a manual `connect()`.
- `connectTimeoutMs` (default 20 000 ms, socket.io's own connect timeout) bounds an attempt including the auth callback and the CONNECT round trip; without it a handshake the server never answers would leave the client in `connecting` forever.
- `retryAfterMs` from a retryable refusal or from `sys.shutdown` is passed to the policy as a floor.
- `unauthenticated` → stop, `offline`, emit `auth_required`. `version_mismatch` → stop, `offline`, emit `incompatible`. A throwing auth callback → `auth_required` with code `unauthenticated`.
- socket.io's `sendBuffer` is cleared on every drop.

- [ ] **Step 1: Write the failing tests**

`packages/http-socket-client/test/connection-resilience.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { recordStates, retryGaps, sleep, until, waitForState } from './support/wait.js';

function expectGaps(actual: number[], expected: number[]): void {
  expect(actual).to.have.length(expected.length);
  actual.forEach((gap, i) => expect(gap, `gap ${i}`).to.be.within(expected[i] - 5, expected[i] + 60));
}

describe('Connection resilience', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('reconnects after the engine connection is killed and asks auth again', async () => {
    let calls = 0;
    const connection = makeConnection(server, { auth: () => ({ token: `t${++calls}` }) });
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(server.handshakes.map((handshake) => handshake.token)).to.deep.equal(['t1', 't2']);
  });

  it('backs off exponentially between refused attempts and starts over after success', async () => {
    let refusing = true;
    server.refuse = () => (refusing ? { code: 'unavailable', message: 'busy', retryable: true } : undefined);
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const states = recordStates(target);

    connection.connect();
    await until(() => server.handshakes.length >= 5);
    refusing = false;
    await waitForState(target, 'online');
    expectGaps(retryGaps(states).slice(0, 4), [20, 40, 80, 100]);

    states.length = 0;
    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');
    expectGaps(retryGaps(states), [20]);
  });

  it('waits retryAfterMs announced by sys.shutdown before the next attempt', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    server.announceShutdown(300);
    await sleep(50);
    const droppedAt = Date.now();
    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(Date.now() - droppedAt).to.be.at.least(290);
  });

  it('honours retryAfterMs of a retryable handshake refusal', async () => {
    let refusals = 1;
    server.refuse = () => (refusals-- > 0 ? { code: 'unavailable', message: 'draining', retryable: true, retryAfterMs: 250 } : undefined);
    const connection = makeConnection(server);
    const startedAt = Date.now();

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(Date.now() - startedAt).to.be.at.least(240);
    expect(server.handshakes).to.have.length(2);
  });

  it('reconnects to a server restarted on the same port', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    await server.stop();
    await waitForState(target, 'offline');
    await sleep(300);
    await server.start(server.port);

    await waitForState(target, 'online', 8000);
  });

  it('abandons a handshake unanswered within connectTimeoutMs and retries', async () => {
    server.holdHandshakes = true;
    const connection = makeConnection(server, { connectTimeoutMs: 150 });
    const target = statefulConnection(connection);
    const states = recordStates(target);

    connection.connect();
    await until(() => server.handshakes.length >= 2, 3000);

    expect(states.slice(0, 3).map((record) => record.state)).to.deep.equal(['connecting', 'offline', 'connecting']);
    expect(states[1].at - states[0].at).to.be.at.least(140);
    server.holdHandshakes = false;
    await waitForState(target, 'online', 3000);
  });

  it('never lets socket.io re-send packets it buffered before a drop', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');
    // Reaches into the private socket: a packet socket.io buffered while the transport was dying.
    const socket = (connection as unknown as { socket: { sendBuffer: unknown[] } }).socket;
    socket.sendBuffer.push({ type: 2, data: ['cmd', { id: 'ghost', name: 'ghost', payload: null }], options: { compress: true } });

    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');
    await sleep(100);

    expect(server.requests.map((request) => request.name)).to.not.include('ghost');
  });
});
```

`packages/http-socket-client/test/handshake-errors.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { SocketError } from '@spinajs/http-socket-common';
import { closeAll } from './support/cleanup.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, waitForState } from './support/wait.js';

const UNAUTHENTICATED: SocketError = { code: 'unauthenticated', message: 'token expired', retryable: false };

describe('Connection handshake errors', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('stops retrying and emits auth_required when the handshake is unauthenticated', async () => {
    server.refuse = () => UNAUTHENTICATED;
    const connection = makeConnection(server);
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));

    connection.connect();
    const [error] = await authRequired;

    expect(error).to.deep.include({ code: 'unauthenticated', message: 'token expired' });
    expect(connection.state).to.equal('offline');
    await sleep(200);
    expect(server.handshakes).to.have.length(1);
    expect(connection.state).to.equal('offline');
  });

  it('connect() after auth_required tries again and asks auth for a fresh token', async () => {
    let token = 'old';
    server.refuse = (handshake) => (handshake.token === 'old' ? UNAUTHENTICATED : undefined);
    const connection = makeConnection(server, { auth: () => ({ token }) });
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));
    connection.connect();
    await authRequired;

    token = 'new';
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(server.handshakes.map((handshake) => handshake.token)).to.deep.equal(['old', 'new']);
  });

  it('stops retrying and emits incompatible on version_mismatch', async () => {
    server.refuse = () => ({ code: 'version_mismatch', message: 'server speaks protocol 2', retryable: false });
    const connection = makeConnection(server);
    const incompatible = nextEmit<[SocketError]>((listener) => connection.events.on('incompatible', listener));

    connection.connect();
    const [error] = await incompatible;

    expect(error.code).to.equal('version_mismatch');
    expect(connection.state).to.equal('offline');
    await sleep(200);
    expect(server.handshakes).to.have.length(1);
  });

  it('treats a throwing auth callback as auth_required without sending a handshake', async () => {
    const connection = makeConnection(server, {
      auth: () => {
        throw new Error('refresh failed');
      },
    });
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));

    connection.connect();
    const [error] = await authRequired;

    expect(error.code).to.equal('unauthenticated');
    expect(error.message).to.contain('refresh failed');
    expect(server.handshakes).to.have.length(0);
    expect(connection.state).to.equal('offline');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/connection-resilience.test.ts test/handshake-errors.test.ts`
Expected: FAIL — the core connection never retries and never emits `auth_required`/`incompatible`: timeouts such as `state 'online' not reached within 5000 ms`, `condition not met`, `no emit within 5000 ms` (and TS2345 on `'auth_required'` if the runner type-checks).

- [ ] **Step 3: Implement — replace `src/connection.ts` entirely**

`packages/http-socket-client/src/connection.ts`:

```ts
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { PROTOCOL_VERSION, type EventFrame, type Handshake, type SocketError } from '@spinajs/http-socket-common';
import { Emitter } from './emitter.js';
import { isSocketError } from './errors.js';
import { ReconnectPolicy, type ReconnectOptions } from './reconnect.js';
import { SYS_SHUTDOWN, WIRE, type ShutdownNotice } from './wire.js';

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'closed';

export interface AuthPayload {
  token?: string;
  [key: string]: unknown;
}

export type AuthProvider = () => AuthPayload | Promise<AuthPayload>;

export type IoOptions = Partial<ManagerOptions & SocketOptions>;

export interface ConnectionOptions {
  url: string;
  path?: string;
  clientId: string;
  auth?: AuthProvider;
  reconnect?: Partial<ReconnectOptions>;
  connectTimeoutMs?: number;
  io?: IoOptions;
  onListenerError?: (error: unknown) => void;
}

export interface ConnectionEvents {
  state: (state: ConnectionState, previous: ConnectionState) => void;
  auth_required: (error: SocketError) => void;
  incompatible: (error: SocketError) => void;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Sole owner of the socket.io socket: state machine, handshake, reconnect and stop conditions.
 * Commands, durable commands and streams use it and never touch socket.io directly.
 */
export class Connection {
  public readonly events: Emitter<ConnectionEvents>;
  private readonly socket: Socket;
  private readonly policy: ReconnectPolicy;
  private readonly connectTimeoutMs: number;
  private current: ConnectionState = 'offline';
  // no automatic attempt may start: before connect(), after disconnect()/close(), after a fatal refusal
  private stopped = true;
  private attempt = 0;
  // bumped whenever an attempt is abandoned, so a late auth callback cannot revive it
  private attemptId = 0;
  private retryAfterMs: number | undefined;
  private retryTimer: Timer | undefined;
  private connectTimer: Timer | undefined;

  constructor(private readonly options: ConnectionOptions) {
    this.events = new Emitter<ConnectionEvents>(options.onListenerError);
    this.policy = new ReconnectPolicy(options.reconnect);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.socket = io(options.url, {
      ...options.io,
      ...(options.path !== undefined ? { path: options.path } : {}),
      autoConnect: false,
      // socket.io's Manager does not retry refused handshakes or server disconnects and cannot
      // honour retryAfterMs; one policy here covers all of them. Reusing this one Socket keeps its
      // pid/offset, which connection state recovery needs.
      reconnection: false,
      // a Manager multiplexed with another client to the same URL would share its failures and closes
      forceNew: true,
      // socket.io's packet retries would re-send commands without idempotency keys
      retries: 0,
      auth: (cb: (data: object) => void) => this.provideAuth(cb),
    });
    this.socket.on('connect', () => this.onConnect());
    this.socket.on('connect_error', (error: Error) => this.onConnectError(error));
    this.socket.on('disconnect', () => this.onDisconnect());
    this.socket.on(WIRE.event, (frame: EventFrame) => this.onEventFrame(frame));
  }

  public get state(): ConnectionState {
    return this.current;
  }

  public get connected(): boolean {
    return this.current === 'online' && this.socket.connected;
  }

  public connect(): void {
    if (this.current === 'closed') throw new Error('the client is closed');
    this.stopped = false;
    if (this.current !== 'offline') return;
    this.attempt = 0;
    this.clearTimers();
    this.open();
  }

  public disconnect(): void {
    if (this.current === 'closed') return;
    this.stopped = true;
    this.abortAttempt();
    this.setState('offline');
  }

  public close(): void {
    if (this.current === 'closed') return;
    this.stopped = true;
    this.setState('closed');
    this.abortAttempt();
  }

  public send(event: string, ...args: unknown[]): boolean {
    if (!this.connected) return false;
    this.socket.emit(event, ...args);
    return true;
  }

  public request<R>(event: string, data: unknown, onReply: (reply: R) => void): boolean {
    if (!this.connected) return false;
    this.socket.emit(event, data, onReply);
    return true;
  }

  public listen(event: string, handler: (...args: any[]) => void): () => void {
    this.socket.on(event, handler);
    return () => {
      this.socket.off(event, handler);
    };
  }

  private open(): void {
    this.attemptId++;
    this.setState('connecting');
    this.connectTimer = setTimeout(() => this.onConnectTimeout(), this.connectTimeoutMs);
    this.socket.connect();
  }

  private provideAuth(cb: (data: object) => void): void {
    const attemptId = this.attemptId;
    Promise.resolve()
      .then(() => this.options.auth?.())
      .then(
        (extra) => {
          if (attemptId !== this.attemptId) return;
          const handshake: Handshake = { ...extra, protocol: PROTOCOL_VERSION, clientId: this.options.clientId };
          cb(handshake);
        },
        (error: unknown) => {
          if (attemptId !== this.attemptId) return;
          const reason = error instanceof Error ? error.message : String(error);
          this.halt('auth_required', { code: 'unauthenticated', message: `auth callback failed: ${reason}`, retryable: false });
        },
      );
  }

  private onConnect(): void {
    this.clearTimers();
    this.attempt = 0;
    this.retryAfterMs = undefined;
    this.setState('online');
  }

  private onConnectError(error: Error): void {
    this.clearConnectTimer();
    if (this.stopped) return;
    const data = (error as Error & { data?: unknown }).data;
    if (isSocketError(data)) {
      if (data.code === 'unauthenticated') return this.halt('auth_required', data);
      if (data.code === 'version_mismatch') return this.halt('incompatible', data);
      if (data.retryAfterMs !== undefined) this.retryAfterMs = data.retryAfterMs;
    }
    this.scheduleRetry();
  }

  private onDisconnect(): void {
    // socket.io re-sends what it buffered during a drop once it reconnects; only the durable
    // queue may re-send a command, and only with an idempotency key
    this.socket.sendBuffer = [];
    if (this.current === 'closed') return;
    this.setState('offline');
    if (!this.stopped) this.scheduleRetry();
  }

  private onEventFrame(frame: EventFrame): void {
    if (frame?.name !== SYS_SHUTDOWN) return;
    const retryAfterMs = (frame.payload as Partial<ShutdownNotice> | undefined)?.retryAfterMs;
    if (typeof retryAfterMs === 'number') this.retryAfterMs = retryAfterMs;
  }

  private onConnectTimeout(): void {
    this.connectTimer = undefined;
    this.abortAttempt();
    this.scheduleRetry();
  }

  private halt(event: 'auth_required' | 'incompatible', error: SocketError): void {
    this.stopped = true;
    this.abortAttempt();
    this.setState('offline');
    this.events.emit(event, error);
  }

  private scheduleRetry(): void {
    this.clearTimers();
    this.setState('offline');
    // a state listener may have closed or stopped the connection
    if (this.current !== 'offline' || this.stopped) return;
    const delay = this.policy.delay(this.attempt++, this.retryAfterMs);
    this.retryAfterMs = undefined;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped && this.current === 'offline') this.open();
    }, delay);
  }

  private abortAttempt(): void {
    this.attemptId++;
    this.clearTimers();
    this.socket.disconnect();
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.current === next) return;
    const previous = this.current;
    this.current = next;
    this.events.emit('state', next, previous);
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/connection.test.ts test/connection-resilience.test.ts test/handshake-errors.test.ts`
Expected: `17 passing` (6 + 7 + 4).

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/connection.ts packages/http-socket-client/test/connection-resilience.test.ts packages/http-socket-client/test/handshake-errors.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): reconnect with backoff, retryAfterMs hints, auth_required and incompatible stops"
```

---

### Task 7: `CommandDispatcher` — replies and the offline policy

**Files:**
- Create: `packages/http-socket-client/src/commands.ts`
- Create: `packages/http-socket-client/test/support/commands.ts`
- Test: `packages/http-socket-client/test/commands.test.ts`

**Interfaces:**
- Consumes: `Connection`, `ConnectionState` (Task 6); `WIRE` (Task 5); `SocketCommandError`, `isSocketError` (Task 2); `CommandReply`, `CommandRequest`, `SocketError` (Task 1).
- Produces: `type WhenOffline = 'fail' | 'wait'`; `interface CommandOptions { timeoutMs?: number; signal?: AbortSignal; whenOffline?: WhenOffline; traceparent?: string }`; `DEFAULT_TIMEOUT_MS = 15_000`; `class CommandDispatcher { constructor(connection: Connection, defaultTimeoutMs?: number); nextId(): string; execute(name: string, payload: unknown, options?: CommandOptions): Promise<unknown> }`. Test support: `onlineDispatcher(server, timeoutMs?)`, `rejectionOf(promise): Promise<SocketCommandError>`.

- [ ] **Step 1: Write the test support and the failing test**

`packages/http-socket-client/test/support/commands.ts`:

```ts
import { expect } from 'chai';
import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { SocketCommandError } from '../../src/errors.js';
import { makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { waitForState } from './wait.js';

export async function onlineDispatcher(server: StubServer, timeoutMs = 1000): Promise<{ connection: Connection; commands: CommandDispatcher }> {
  const connection = makeConnection(server);
  const commands = new CommandDispatcher(connection, timeoutMs);
  connection.connect();
  await waitForState(statefulConnection(connection), 'online');
  return { connection, commands };
}

export async function rejectionOf(promise: Promise<unknown>): Promise<SocketCommandError> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(SocketCommandError);
    return error as SocketCommandError;
  }
  throw new Error('expected the promise to reject');
}
```

`packages/http-socket-client/test/commands.test.ts`:

```ts
import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { CommandDispatcher } from '../src/commands.js';
import { closeAll } from './support/cleanup.js';
import { onlineDispatcher, rejectionOf } from './support/commands.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { sleep, waitForState } from './support/wait.js';

chai.use(chaiAsPromised);

describe('CommandDispatcher replies', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    server.handlers.set('ping', () => 'pong');
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('resolves with the result and sends {id, name, payload, deadline, traceparent}', async () => {
    server.handlers.set('math.add', (payload: { a: number; b: number }) => payload.a + payload.b);
    const { commands } = await onlineDispatcher(server);

    await expect(commands.execute('math.add', { a: 2, b: 3 }, { traceparent: '00-abc-def-01' })).to.eventually.equal(5);

    const [request] = server.requests;
    expect(request).to.include({ name: 'math.add', traceparent: '00-abc-def-01' });
    expect(request.id).to.be.a('string');
    expect(request.payload).to.deep.equal({ a: 2, b: 3 });
    expect(request.deadline).to.be.within(1, 1000);
    expect(request).to.not.have.property('idempotencyKey');
  });

  it('resolves a void command with undefined and gives every request its own id', async () => {
    server.handlers.set('docs.touch', () => undefined);
    const { commands } = await onlineDispatcher(server);

    expect(await commands.execute('docs.touch', { id: 1 })).to.equal(undefined);
    await commands.execute('docs.touch', { id: 2 });

    expect(server.requests[0].id).to.not.equal(server.requests[1].id);
  });

  it('rejects with a SocketCommandError carrying the server SocketError', async () => {
    server.handlers.set('docs.open', () => {
      throw { code: 'not_found', message: 'no such doc', retryable: false, errorId: 'e-9' };
    });
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('docs.open', { id: 'x' }));

    expect(error.message).to.equal('docs.open: no such doc');
    expect(error.command).to.equal('docs.open');
    expect(error.error).to.deep.equal({ code: 'not_found', message: 'no such doc', retryable: false, errorId: 'e-9' });
  });

  it('passes unimplemented through for an unknown command', async () => {
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('docs.nope', null));

    expect(error.code).to.equal('unimplemented');
    expect(error.retryable).to.equal(false);
  });

  it('rejects a stream reply with failed_precondition', async () => {
    server.rawReplies.set('docs.snapshot', (request) => ({ id: request.id, ok: true, stream: true }));
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('docs.snapshot', null));

    expect(error.code).to.equal('failed_precondition');
  });

  it('rejects a malformed reply with internal', async () => {
    server.rawReplies.set('bad', () => 'garbage');
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('bad', null));

    expect(error.error).to.deep.equal({ code: 'internal', message: 'malformed reply', retryable: false });
  });

  it('carries binary payloads and results as socket.io attachments', async () => {
    server.handlers.set('echo', (payload: unknown) => payload);
    const { commands } = await onlineDispatcher(server);

    const result = await commands.execute('echo', new Uint8Array([1, 2, 3]));

    expect(Array.from(new Uint8Array(result as ArrayBuffer))).to.deep.equal([1, 2, 3]);
  });

  it("whenOffline 'fail' (the default) rejects at once with retryable unavailable", async () => {
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 1000);

    const error = await rejectionOf(commands.execute('ping', null));

    expect(error.error).to.deep.equal({ code: 'unavailable', message: 'the client is offline', retryable: true });
    await sleep(30);
    expect(server.requests).to.have.length(0);
  });

  it("whenOffline 'wait' holds commands until online and sends them in call order", async () => {
    server.handlers.set('a', () => 'A');
    server.handlers.set('b', () => 'B');
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 2000);
    const first = commands.execute('a', null, { whenOffline: 'wait' });
    const second = commands.execute('b', null, { whenOffline: 'wait' });

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(await Promise.all([first, second])).to.deep.equal(['A', 'B']);
    expect(server.requests.map((request) => request.name)).to.deep.equal(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/commands.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/commands.js`.

- [ ] **Step 3: Implement (Task 8 replaces this file with the version that adds deadlines and cancellation)**

`packages/http-socket-client/src/commands.ts`:

```ts
import type { CommandReply, CommandRequest, SocketError } from '@spinajs/http-socket-common';
import type { Connection, ConnectionState } from './connection.js';
import { SocketCommandError, isSocketError } from './errors.js';
import { WIRE } from './wire.js';

export type WhenOffline = 'fail' | 'wait';

export interface CommandOptions {
  /** Budget for the whole call: the wait for a connection (whenOffline 'wait') and for the reply. */
  timeoutMs?: number;
  signal?: AbortSignal;
  whenOffline?: WhenOffline;
  /** W3C trace context, carried into the server handler. */
  traceparent?: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

const OFFLINE: SocketError = { code: 'unavailable', message: 'the client is offline', retryable: true };
const CONNECTION_LOST: SocketError = { code: 'unavailable', message: 'the connection dropped before the reply', retryable: true };
const STREAM_REPLY: SocketError = { code: 'failed_precondition', message: 'the command replies with a stream; use stream()', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };

interface PendingCommand {
  readonly request: CommandRequest;
  readonly deadlineAt: number;
  done: boolean;
  resolve(value: unknown): void;
  reject(error: SocketCommandError): void;
}

/** Plain (non-durable) commands: one attempt each, never re-sent. */
export class CommandDispatcher {
  private seq = 0;
  // insertion-ordered, so commands held while offline go out in call order
  private readonly waiting = new Set<PendingCommand>();
  private readonly inFlight = new Set<PendingCommand>();

  constructor(private readonly connection: Connection, private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    connection.events.on('state', (state) => this.onState(state));
  }

  /** Unique per client instance; durable and stream requests take ids from here too. */
  public nextId(): string {
    return (++this.seq).toString(36);
  }

  public execute(name: string, payload: unknown, options: CommandOptions = {}): Promise<unknown> {
    if (!this.connection.connected && (options.whenOffline ?? 'fail') === 'fail') return rejected(OFFLINE, name);

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const request: CommandRequest = { id: this.nextId(), name, payload };
    if (options.traceparent !== undefined) request.traceparent = options.traceparent;

    return new Promise<unknown>((resolve, reject) => {
      const command: PendingCommand = { request, deadlineAt: Date.now() + timeoutMs, done: false, resolve, reject };
      if (this.connection.connected) this.transmit(command);
      else this.waiting.add(command);
    });
  }

  private transmit(command: PendingCommand): void {
    this.waiting.delete(command);
    // a relative budget, so client/server clock skew cannot expire it
    command.request.deadline = Math.max(0, command.deadlineAt - Date.now());
    this.inFlight.add(command);
    const sent = this.connection.request<CommandReply>(WIRE.command, command.request, (reply) => this.onReply(command, reply));
    if (!sent) this.fail(command, CONNECTION_LOST);
  }

  private onReply(command: PendingCommand, reply: CommandReply): void {
    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') return this.fail(command, MALFORMED_REPLY);
    if (!reply.ok) return this.fail(command, isSocketError(reply.error) ? reply.error : MALFORMED_REPLY);
    if ('stream' in reply && reply.stream === true) return this.fail(command, STREAM_REPLY);
    // JSON drops an undefined result, so a void command replies without the key
    this.succeed(command, 'result' in reply ? reply.result : undefined);
  }

  private onState(state: ConnectionState): void {
    if (state === 'online') for (const command of [...this.waiting]) this.transmit(command);
  }

  private succeed(command: PendingCommand, value: unknown): void {
    if (this.finish(command)) command.resolve(value);
  }

  private fail(command: PendingCommand, error: SocketError): void {
    if (this.finish(command)) command.reject(new SocketCommandError({ ...error }, command.request.name));
  }

  private finish(command: PendingCommand): boolean {
    if (command.done) return false;
    command.done = true;
    this.waiting.delete(command);
    this.inFlight.delete(command);
    return true;
  }
}

function rejected(error: SocketError, name: string): Promise<never> {
  return Promise.reject(new SocketCommandError({ ...error }, name));
}
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/commands.test.ts`
Expected: `9 passing`.

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/commands.ts packages/http-socket-client/test/support/commands.ts packages/http-socket-client/test/commands.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): plain commands with typed errors and the whenOffline policy"
```

---

### Task 8: `CommandDispatcher` — deadlines, cancellation, drops, close

**Files:**
- Modify (full replacement): `packages/http-socket-client/src/commands.ts`
- Test: `packages/http-socket-client/test/command-failures.test.ts`

**Interfaces:**
- Consumes: everything Task 7 consumed; `connection.send(WIRE.cancel, { id })`.
- Produces: same public surface as Task 7. Error contract (each a `SocketCommandError` whose `error` is exactly):
  - closed client: `{ code: 'unavailable', message: 'the client is closed', retryable: false }`
  - offline + `'fail'`: `{ code: 'unavailable', message: 'the client is offline', retryable: true }`
  - `'wait'` timed out before sending: `{ code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true }`
  - drop after sending: `{ code: 'unavailable', message: 'the connection dropped before the reply', retryable: true }`
  - sent, no reply in time: `{ code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true }`
  - aborted signal: `{ code: 'cancelled', message: 'the command was cancelled', retryable: false }`; if already sent, `cancel` `{ id }` goes to the server.

- [ ] **Step 1: Write the failing test**

`packages/http-socket-client/test/command-failures.test.ts`:

```ts
import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { CommandDispatcher } from '../src/commands.js';
import { closeAll } from './support/cleanup.js';
import { onlineDispatcher, rejectionOf } from './support/commands.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until, waitForState } from './support/wait.js';

chai.use(chaiAsPromised);

describe('CommandDispatcher failures', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    server.handlers.set('ping', () => 'pong');
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('rejects with retryable deadline_exceeded when the reply is late, and ignores the late reply', async () => {
    server.ackFault = { kind: 'delay', ms: 300 };
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('ping', null, { timeoutMs: 100 }));

    expect(error.error).to.deep.equal({ code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true });
    expect(error.message).to.equal('ping: no reply before the timeout');
    await sleep(300);
  });

  it('rejects with deadline_exceeded when the ack never comes', async () => {
    server.ackFault = { kind: 'drop' };
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('ping', null, { timeoutMs: 100 }));

    expect(error.code).to.equal('deadline_exceeded');
  });

  it("rejects a 'wait' command that stays offline until its timeout with retryable unavailable", async () => {
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 1000);

    const error = await rejectionOf(commands.execute('ping', null, { whenOffline: 'wait', timeoutMs: 100 }));

    expect(error.error).to.deep.equal({ code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true });
  });

  it('rejects at once with cancelled when the signal is already aborted', async () => {
    const { commands } = await onlineDispatcher(server);
    const controller = new AbortController();
    controller.abort();

    const error = await rejectionOf(commands.execute('ping', null, { signal: controller.signal }));

    expect(error.error).to.deep.equal({ code: 'cancelled', message: 'the command was cancelled', retryable: false });
    await sleep(30);
    expect(server.requests).to.have.length(0);
  });

  it('cancels a waiting command so it is never sent', async () => {
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 2000);
    const controller = new AbortController();
    const pending = rejectionOf(commands.execute('ping', null, { whenOffline: 'wait', signal: controller.signal }));

    controller.abort();
    expect((await pending).code).to.equal('cancelled');
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');
    await sleep(50);

    expect(server.requests).to.have.length(0);
  });

  it('cancels a command in flight and tells the server', async () => {
    server.ackFault = { kind: 'drop' };
    const { commands } = await onlineDispatcher(server, 2000);
    const controller = new AbortController();
    const pending = rejectionOf(commands.execute('ping', null, { signal: controller.signal }));
    await until(() => server.requests.length === 1);

    controller.abort();

    expect((await pending).code).to.equal('cancelled');
    await until(() => server.cancels.length === 1);
    expect(server.cancels).to.deep.equal([server.requests[0].id]);
  });

  it('rejects with retryable unavailable on a drop mid-command and never re-sends it', async () => {
    server.ackFault = { kind: 'drop' };
    const { connection, commands } = await onlineDispatcher(server, 2000);
    const target = statefulConnection(connection);
    const lost = rejectionOf(commands.execute('ping', null));
    await until(() => server.requests.length === 1);

    server.killConnections();

    expect((await lost).error).to.deep.equal({ code: 'unavailable', message: 'the connection dropped before the reply', retryable: true });
    server.ackFault = { kind: 'none' };
    await waitForState(target, 'online');
    await expect(commands.execute('ping', null)).to.eventually.equal('pong');
    expect(server.requests.map((request) => request.name)).to.deep.equal(['ping', 'ping']);
  });

  it('close() rejects waiting and in-flight commands, and every later one, as closed', async () => {
    server.ackFault = { kind: 'drop' };
    const { connection, commands } = await onlineDispatcher(server, 2000);
    const inFlight = rejectionOf(commands.execute('ping', null));
    await until(() => server.requests.length === 1);
    connection.disconnect();
    const waiting = rejectionOf(commands.execute('ping', null, { whenOffline: 'wait' }));

    connection.close();

    const closed = { code: 'unavailable', message: 'the client is closed', retryable: false };
    expect((await waiting).error).to.deep.equal(closed);
    expect((await inFlight).code).to.equal('unavailable');
    expect((await rejectionOf(commands.execute('ping', null))).error).to.deep.equal(closed);
  });
});
```

Note on the last test: `disconnect()` already rejects the in-flight command as "dropped" before `close()`; the test only pins its code. The waiting command and later calls must report `closed`.

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/command-failures.test.ts`
Expected: FAIL — `Timeout of 10000ms exceeded` for the deadline, wait and close tests, `expected the promise to reject` for the abort-before test, and an in-flight command that never rejects on the drop.

- [ ] **Step 3: Implement — replace `src/commands.ts` entirely**

`packages/http-socket-client/src/commands.ts`:

```ts
import type { CommandReply, CommandRequest, SocketError } from '@spinajs/http-socket-common';
import type { Connection, ConnectionState } from './connection.js';
import { SocketCommandError, isSocketError } from './errors.js';
import { WIRE } from './wire.js';

export type WhenOffline = 'fail' | 'wait';

export interface CommandOptions {
  /** Budget for the whole call: the wait for a connection (whenOffline 'wait') and for the reply. */
  timeoutMs?: number;
  signal?: AbortSignal;
  whenOffline?: WhenOffline;
  /** W3C trace context, carried into the server handler. */
  traceparent?: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

const CLOSED: SocketError = { code: 'unavailable', message: 'the client is closed', retryable: false };
const OFFLINE: SocketError = { code: 'unavailable', message: 'the client is offline', retryable: true };
const STAYED_OFFLINE: SocketError = { code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true };
const CONNECTION_LOST: SocketError = { code: 'unavailable', message: 'the connection dropped before the reply', retryable: true };
const NO_REPLY: SocketError = { code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true };
const CANCELLED: SocketError = { code: 'cancelled', message: 'the command was cancelled', retryable: false };
const STREAM_REPLY: SocketError = { code: 'failed_precondition', message: 'the command replies with a stream; use stream()', retryable: false };
const MALFORMED_REPLY: SocketError = { code: 'internal', message: 'malformed reply', retryable: false };

type Timer = ReturnType<typeof setTimeout>;

interface PendingCommand {
  readonly request: CommandRequest;
  readonly deadlineAt: number;
  sent: boolean;
  done: boolean;
  resolve(value: unknown): void;
  reject(error: SocketCommandError): void;
  dispose(): void;
}

/** Plain (non-durable) commands: one attempt each, never re-sent. */
export class CommandDispatcher {
  private seq = 0;
  // insertion-ordered, so commands held while offline go out in call order
  private readonly waiting = new Set<PendingCommand>();
  private readonly inFlight = new Set<PendingCommand>();

  constructor(private readonly connection: Connection, private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    connection.events.on('state', (state, previous) => this.onState(state, previous));
  }

  /** Unique per client instance; durable and stream requests take ids from here too. */
  public nextId(): string {
    return (++this.seq).toString(36);
  }

  public execute(name: string, payload: unknown, options: CommandOptions = {}): Promise<unknown> {
    if (this.connection.state === 'closed') return rejected(CLOSED, name);
    if (options.signal?.aborted) return rejected(CANCELLED, name);
    if (!this.connection.connected && (options.whenOffline ?? 'fail') === 'fail') return rejected(OFFLINE, name);

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const request: CommandRequest = { id: this.nextId(), name, payload };
    if (options.traceparent !== undefined) request.traceparent = options.traceparent;
    const signal = options.signal;

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (command.sent) this.connection.send(WIRE.cancel, { id: request.id });
        this.fail(command, CANCELLED);
      };
      const timer: Timer = setTimeout(() => this.fail(command, command.sent ? NO_REPLY : STAYED_OFFLINE), timeoutMs);
      const command: PendingCommand = {
        request,
        deadlineAt: Date.now() + timeoutMs,
        sent: false,
        done: false,
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (this.connection.connected) this.transmit(command);
      else this.waiting.add(command);
    });
  }

  private transmit(command: PendingCommand): void {
    this.waiting.delete(command);
    // a relative budget, so client/server clock skew cannot expire it
    command.request.deadline = Math.max(0, command.deadlineAt - Date.now());
    command.sent = true;
    this.inFlight.add(command);
    const sent = this.connection.request<CommandReply>(WIRE.command, command.request, (reply) => this.onReply(command, reply));
    if (!sent) this.fail(command, CONNECTION_LOST);
  }

  private onReply(command: PendingCommand, reply: CommandReply): void {
    if (typeof reply !== 'object' || reply === null || typeof reply.ok !== 'boolean') return this.fail(command, MALFORMED_REPLY);
    if (!reply.ok) return this.fail(command, isSocketError(reply.error) ? reply.error : MALFORMED_REPLY);
    if ('stream' in reply && reply.stream === true) return this.fail(command, STREAM_REPLY);
    // JSON drops an undefined result, so a void command replies without the key
    this.succeed(command, 'result' in reply ? reply.result : undefined);
  }

  private onState(state: ConnectionState, previous: ConnectionState): void {
    if (state === 'closed') {
      for (const command of [...this.waiting, ...this.inFlight]) this.fail(command, CLOSED);
      return;
    }
    if (previous === 'online') for (const command of [...this.inFlight]) this.fail(command, CONNECTION_LOST);
    if (state === 'online') for (const command of [...this.waiting]) this.transmit(command);
  }

  private succeed(command: PendingCommand, value: unknown): void {
    if (this.finish(command)) command.resolve(value);
  }

  private fail(command: PendingCommand, error: SocketError): void {
    if (this.finish(command)) command.reject(new SocketCommandError({ ...error }, command.request.name));
  }

  private finish(command: PendingCommand): boolean {
    if (command.done) return false;
    command.done = true;
    command.dispose();
    this.waiting.delete(command);
    this.inFlight.delete(command);
    return true;
  }
}

function rejected(error: SocketError, name: string): Promise<never> {
  return Promise.reject(new SocketCommandError({ ...error }, name));
}
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/commands.test.ts test/command-failures.test.ts`
Expected: `17 passing` (9 + 8).

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/commands.ts packages/http-socket-client/test/command-failures.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): command deadlines, AbortSignal cancellation, drop and close handling"
```

---

### Task 9: `SocketClient` facade and events

**Files:**
- Create: `packages/http-socket-client/src/client.ts`
- Create: `packages/http-socket-client/test/support/client.ts`
- Test: `packages/http-socket-client/test/client.test.ts`

**Interfaces:**
- Consumes: `Connection`, `AuthProvider`, `ConnectionState`, `IoOptions` (Task 6); `CommandDispatcher`, `CommandOptions`, `DEFAULT_TIMEOUT_MS` (Task 8); `Emitter`, `rethrowAsync` (Task 3); `SocketCommandError` (Task 2); `randomId` (Task 2); `ReconnectOptions` (Task 4); `WIRE` (Task 5); `EventFrame`, `SocketError` (Task 1).
- Produces:
  - `interface SocketClientOptions { url: string; path?: string; auth?: AuthProvider; clientId?: string; reconnect?: Partial<ReconnectOptions>; defaultTimeoutMs?: number; connectTimeoutMs?: number; autoConnect?: boolean; io?: IoOptions; onListenerError?: (error: unknown) => void }`
  - `interface ClientLifecycleEvents { state(state, previous); auth_required(error: SocketError); incompatible(error: SocketError); failed(event: FailedCommand) }`, `interface FailedCommand { entry: unknown; error: SocketError }`, `type LifecycleEventName = keyof ClientLifecycleEvents`, `LIFECYCLE_EVENTS: ReadonlySet<string>`, `type ServerEventListener<T = unknown> = (payload: T) => void`, `type Unsubscribe = () => void`
  - `class SocketClient { readonly clientId: string; get state(): ConnectionState; connect(): void; disconnect(): void; close(): void; command<R = unknown>(name: string, payload?: unknown, options?: CommandOptions): Promise<R>; durable<R = unknown>(name: string, payload?: unknown): Promise<R>; stream<T = unknown>(name: string, payload?: unknown, options?: CommandOptions): AsyncIterable<T>; emit(name: string, payload?: unknown): boolean; on/once(event, listener): Unsubscribe; off(event, listener): void }` (Task 10 adds `typed()`).
  - Test support: `makeClient(server, overrides?)`, `statefulClient(client)`.

- [ ] **Step 1: Write the test support and the failing test**

`packages/http-socket-client/test/support/client.ts`:

```ts
import { SocketClient, type SocketClientOptions } from '../../src/client.js';
import { track } from './cleanup.js';
import { FAST_RECONNECT } from './connection.js';
import type { StubServer } from './stub-server.js';
import type { Stateful } from './wait.js';

export function makeClient(server: StubServer, overrides: Partial<SocketClientOptions> = {}): SocketClient {
  return track(new SocketClient({ url: server.url, clientId: 'client-1', reconnect: FAST_RECONNECT, io: { transports: ['websocket'] }, ...overrides }));
}

export function statefulClient(client: SocketClient): Stateful {
  return {
    get state() {
      return client.state;
    },
    onState: (listener) => client.on('state', listener),
  };
}
```

`packages/http-socket-client/test/client.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { SocketError } from '@spinajs/http-socket-common';
import type { ConnectionState } from '../src/connection.js';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { rejectionOf } from './support/commands.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, until, waitForState } from './support/wait.js';

describe('SocketClient', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    server.handlers.set('ping', () => 'pong');
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('connects on construction and reports state changes with the previous state', async () => {
    const client = makeClient(server);
    expect(client.state).to.equal('connecting');

    const [state, previous] = await nextEmit<[ConnectionState, ConnectionState]>((listener) => client.on('state', listener));

    expect([state, previous]).to.deep.equal(['online', 'connecting']);
    expect(await client.command('ping')).to.equal('pong');
  });

  it("with autoConnect: false stays offline; a 'wait' command goes out on connect()", async () => {
    const client = makeClient(server, { autoConnect: false });
    await sleep(50);
    expect(client.state).to.equal('offline');
    const pending = client.command<string>('ping', null, { whenOffline: 'wait' });

    client.connect();

    expect(await pending).to.equal('pong');
  });

  it('applies defaultTimeoutMs as the command budget', async () => {
    const client = makeClient(server, { defaultTimeoutMs: 1234 });
    await waitForState(statefulClient(client), 'online');

    await client.command('ping');

    expect(server.requests[0].deadline).to.be.within(1000, 1234);
  });

  it('delivers server events to on() listeners; unsubscribe, off() and once() stop them', async () => {
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const viaOn: number[] = [];
    const viaOff: number[] = [];
    const viaOnce: number[] = [];
    const unsubscribe = client.on<{ rev: number }>('docs.committed', (event) => viaOn.push(event.rev));
    const offListener = (event: { rev: number }): void => {
      viaOff.push(event.rev);
    };
    client.on('docs.committed', offListener);
    client.once<{ rev: number }>('docs.committed', (event) => viaOnce.push(event.rev));

    server.emitEvent('docs.committed', { rev: 1 });
    await until(() => viaOn.length === 1);
    unsubscribe();
    client.off('docs.committed', offListener);
    server.emitEvent('docs.committed', { rev: 2 });
    await sleep(50);

    expect(viaOn).to.deep.equal([1]);
    expect(viaOff).to.deep.equal([1]);
    expect(viaOnce).to.deep.equal([1]);
  });

  it('never routes a server event named like a lifecycle event to lifecycle listeners', async () => {
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const states: unknown[] = [];
    client.on('state', (state) => states.push(state));

    server.emitEvent('state', 'hijack');
    await sleep(50);

    expect(states).to.deep.equal([]);
  });

  it('emit() sends an event frame when online and drops it when offline', async () => {
    const client = makeClient(server, { autoConnect: false });
    expect(client.emit('docs.cursor', { x: 0 })).to.equal(false);
    client.connect();
    await waitForState(statefulClient(client), 'online');

    expect(client.emit('docs.cursor', { x: 1 })).to.equal(true);

    await until(() => server.clientEvents.length === 1);
    expect(server.clientEvents).to.deep.equal([{ name: 'docs.cursor', payload: { x: 1 } }]);
  });

  it('reports a throwing listener to onListenerError and still calls the others', async () => {
    const errors: unknown[] = [];
    const client = makeClient(server, { onListenerError: (error) => errors.push(error) });
    await waitForState(statefulClient(client), 'online');
    const seen: number[] = [];
    client.on('tick', () => {
      throw new Error('boom');
    });
    client.on<number>('tick', (n) => seen.push(n));

    server.emitEvent('tick', 1);
    await until(() => seen.length === 1);

    expect(errors).to.have.length(1);
    expect((errors[0] as Error).message).to.equal('boom');
  });

  it('reserves durable() and stream(): both reject with unimplemented', async () => {
    const client = makeClient(server, { autoConnect: false });

    const durableError = await rejectionOf(client.durable('docs.submit', {}));
    const iterator = client.stream('docs.snapshot', {})[Symbol.asyncIterator]();
    const streamError = await rejectionOf(iterator.next());

    expect(durableError.code).to.equal('unimplemented');
    expect(streamError.code).to.equal('unimplemented');
  });

  it('generates a clientId when none is given and sends it in the handshake', async () => {
    const client = makeClient(server, { clientId: undefined });
    await waitForState(statefulClient(client), 'online');

    expect(client.clientId).to.be.a('string').and.not.equal('');
    expect(server.handshakes[0].clientId).to.equal(client.clientId);
  });

  it('forwards auth_required and incompatible', async () => {
    server.refuse = (handshake) =>
      handshake.clientId === 'needs-login'
        ? { code: 'unauthenticated', message: 'login', retryable: false }
        : { code: 'version_mismatch', message: 'too old', retryable: false };
    const loggedOut = makeClient(server, { clientId: 'needs-login', autoConnect: false });
    const outdated = makeClient(server, { clientId: 'outdated', autoConnect: false });
    const authRequired = nextEmit<[SocketError]>((listener) => loggedOut.on('auth_required', listener));
    const incompatible = nextEmit<[SocketError]>((listener) => outdated.on('incompatible', listener));

    loggedOut.connect();
    outdated.connect();

    expect((await authRequired)[0].code).to.equal('unauthenticated');
    expect((await incompatible)[0].code).to.equal('version_mismatch');
  });

  it('close() rejects pending commands and makes the client terminal', async () => {
    const client = makeClient(server, { autoConnect: false });
    const pending = rejectionOf(client.command('ping', null, { whenOffline: 'wait' }));

    client.close();

    expect(client.state).to.equal('closed');
    expect((await pending).message).to.equal('ping: the client is closed');
    expect(() => client.connect()).to.throw('the client is closed');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/client.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../../src/client.js`.

- [ ] **Step 3: Implement**

`packages/http-socket-client/src/client.ts`:

```ts
import type { EventFrame, SocketError } from '@spinajs/http-socket-common';
import { CommandDispatcher, DEFAULT_TIMEOUT_MS, type CommandOptions } from './commands.js';
import { Connection, type AuthProvider, type ConnectionState, type IoOptions } from './connection.js';
import { Emitter, rethrowAsync } from './emitter.js';
import { SocketCommandError } from './errors.js';
import { randomId } from './ids.js';
import type { ReconnectOptions } from './reconnect.js';
import { WIRE } from './wire.js';

export interface SocketClientOptions {
  /** Server origin; a path in it selects a socket.io namespace. */
  url: string;
  /** socket.io endpoint path (socket.io's default: '/socket.io'). */
  path?: string;
  /** Asked on every (re)connect; its fields go into the handshake. */
  auth?: AuthProvider;
  /** Stable per install, persisted by the app. Generated when omitted. */
  clientId?: string;
  reconnect?: Partial<ReconnectOptions>;
  defaultTimeoutMs?: number;
  connectTimeoutMs?: number;
  autoConnect?: boolean;
  /** Passed to socket.io-client; reconnection, autoConnect, forceNew, retries and auth stay owned by the client. */
  io?: IoOptions;
  onListenerError?: (error: unknown) => void;
}

export interface FailedCommand {
  entry: unknown;
  error: SocketError;
}

export interface ClientLifecycleEvents {
  state: (state: ConnectionState, previous: ConnectionState) => void;
  auth_required: (error: SocketError) => void;
  incompatible: (error: SocketError) => void;
  /** Reserved for durable commands: an outbox entry the server refused for good. */
  failed: (event: FailedCommand) => void;
}

export type LifecycleEventName = keyof ClientLifecycleEvents;

/** Names `on()` routes to client lifecycle listeners; server events with these names are unreachable. */
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set<LifecycleEventName>(['state', 'auth_required', 'incompatible', 'failed']);

export type ServerEventListener<T = unknown> = (payload: T) => void;
export type Unsubscribe = () => void;

type AnyListener = (...args: any[]) => void;
type ServerEvents = Record<string, ServerEventListener>;

function isLifecycleEvent(event: string): event is LifecycleEventName {
  return LIFECYCLE_EVENTS.has(event);
}

export class SocketClient {
  public readonly clientId: string;
  private readonly connection: Connection;
  private readonly commands: CommandDispatcher;
  private readonly lifecycle: Emitter<ClientLifecycleEvents>;
  private readonly serverEvents: Emitter<ServerEvents>;

  constructor(options: SocketClientOptions) {
    const onListenerError = options.onListenerError ?? rethrowAsync;
    this.clientId = options.clientId ?? randomId();
    this.lifecycle = new Emitter<ClientLifecycleEvents>(onListenerError);
    this.serverEvents = new Emitter<ServerEvents>(onListenerError);
    this.connection = new Connection({
      url: options.url,
      path: options.path,
      clientId: this.clientId,
      auth: options.auth,
      reconnect: options.reconnect,
      connectTimeoutMs: options.connectTimeoutMs,
      io: options.io,
      onListenerError,
    });
    this.commands = new CommandDispatcher(this.connection, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);

    this.connection.events.on('state', (state, previous) => this.lifecycle.emit('state', state, previous));
    this.connection.events.on('auth_required', (error) => this.lifecycle.emit('auth_required', error));
    this.connection.events.on('incompatible', (error) => this.lifecycle.emit('incompatible', error));
    this.connection.listen(WIRE.event, (frame: EventFrame) => {
      if (typeof frame?.name === 'string') this.serverEvents.emit(frame.name, frame.payload);
    });

    if (options.autoConnect !== false) this.connect();
  }

  public get state(): ConnectionState {
    return this.connection.state;
  }

  public connect(): void {
    this.connection.connect();
  }

  /** Goes offline and stops reconnecting until connect(). */
  public disconnect(): void {
    this.connection.disconnect();
  }

  /** Terminal: rejects pending commands and releases the socket. */
  public close(): void {
    this.connection.close();
  }

  public command<R = unknown>(name: string, payload?: unknown, options?: CommandOptions): Promise<R> {
    return this.commands.execute(name, payload, options) as Promise<R>;
  }

  /** Reserved: durable commands arrive with the outbox store. */
  public durable<R = unknown>(name: string, _payload?: unknown): Promise<R> {
    return Promise.reject(new SocketCommandError({ code: 'unimplemented', message: 'durable() is not available yet', retryable: false }, name));
  }

  /** Reserved: stream replies arrive with credit-based flow control. */
  public stream<T = unknown>(name: string, _payload?: unknown, _options?: CommandOptions): AsyncIterable<T> {
    const error = new SocketCommandError({ code: 'unimplemented', message: 'stream() is not available yet', retryable: false }, name);
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(error),
      }),
    };
  }

  /** Fire-and-forget event to the server; returns false and drops it when not online. */
  public emit(name: string, payload?: unknown): boolean {
    const frame: EventFrame = { name, payload };
    return this.connection.send(WIRE.event, frame);
  }

  public on<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  public on<T = unknown>(event: string, listener: ServerEventListener<T>): Unsubscribe;
  public on(event: string, listener: AnyListener): Unsubscribe {
    return isLifecycleEvent(event) ? this.lifecycle.on(event, listener) : this.serverEvents.on(event, listener);
  }

  public once<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  public once<T = unknown>(event: string, listener: ServerEventListener<T>): Unsubscribe;
  public once(event: string, listener: AnyListener): Unsubscribe {
    return isLifecycleEvent(event) ? this.lifecycle.once(event, listener) : this.serverEvents.once(event, listener);
  }

  public off<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): void;
  public off<T = unknown>(event: string, listener: ServerEventListener<T>): void;
  public off(event: string, listener: AnyListener): void {
    if (isLifecycleEvent(event)) this.lifecycle.off(event, listener);
    else this.serverEvents.off(event, listener);
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/client.test.ts`
Expected: `11 passing`.

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/client.ts packages/http-socket-client/test/support/client.ts packages/http-socket-client/test/client.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): SocketClient facade with lifecycle and server events, durable/stream reserved"
```

---

### Task 10: Typed contracts

Spec §6 says `defineContract<…>()` "returns a TypedSocketClient". Taken literally that is infeasible: `defineContract` lives in the dependency-free common package and cannot know the client. The contract value is a typing-only marker; the client turns it into a typed view with `client.typed(contract)`, which returns the same instance.

**Files:**
- Create: `packages/http-socket-client/src/contract.ts`
- Modify: `packages/http-socket-client/src/client.ts` (imports + `typed()` method)
- Test: `packages/http-socket-client/test/contract.test.ts`

**Interfaces:**
- Consumes: `SocketContract`, `Contract`, `CommandName`, `CommandPayload`, `CommandResult`, `EventName`, `EventPayload`, `defineContract` (Task 1); `SocketClient`, `ClientLifecycleEvents`, `LifecycleEventName`, `Unsubscribe` (Task 9); `CommandOptions` (Task 8); `ConnectionState` (Task 6).
- Produces: `type StreamItem<C, N>`; `interface TypedSocketClient<C extends SocketContract>`; `SocketClient.typed<C extends SocketContract>(contract: Contract<C>): TypedSocketClient<C>`.

- [ ] **Step 1: Write the failing test**

`packages/http-socket-client/test/contract.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { defineContract } from '@spinajs/http-socket-common';
import type { TypedSocketClient } from '../src/contract.js';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { StubServer } from './support/stub-server.js';
import { until, waitForState } from './support/wait.js';

type DocsContract = {
  commands: {
    'docs.open': [{ id: string }, { title: string }];
    'docs.touch': [{ id: string }, void];
    'docs.snapshot': [{ id: string }, AsyncIterable<{ part: number }>];
  };
  events: {
    'docs.committed': { rev: number };
    'docs.cursor': { x: number };
  };
};

const Docs = defineContract<DocsContract>();

describe('typed contracts', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('typed() returns the same client with contract-checked commands and events', async () => {
    server.handlers.set('docs.open', (payload: { id: string }) => ({ title: `doc ${payload.id}` }));
    const client = makeClient(server);
    const api = client.typed(Docs);
    expect(api).to.equal(client);
    await waitForState(statefulClient(client), 'online');

    const opened = await api.command('docs.open', { id: '7' });
    const revisions: number[] = [];
    api.on('docs.committed', (event) => revisions.push(event.rev));
    server.emitEvent('docs.committed', { rev: 3 });
    await until(() => revisions.length === 1);

    expect(opened.title).to.equal('doc 7');
    expect(revisions).to.deep.equal([3]);
    expect(api.emit('docs.cursor', { x: 1 })).to.equal(true);
  });
});

// Compile-time only; `npm run typecheck` fails if an expectation below stops holding.
function typeChecks(api: TypedSocketClient<DocsContract>): void {
  // @ts-expect-error unknown command name
  void api.command('docs.nope', {});
  // @ts-expect-error payload of the wrong shape
  void api.command('docs.open', { id: 7 });
  const opened: Promise<{ title: string }> = api.command('docs.open', { id: '1' });
  const touched: Promise<void> = api.command('docs.touch', { id: '1' });
  const parts: AsyncIterable<{ part: number }> = api.stream('docs.snapshot', { id: '1' });
  // @ts-expect-error unknown event name
  api.on('docs.nope', () => undefined);
  api.on('docs.committed', (event) => {
    const rev: number = event.rev;
    void rev;
  });
  // @ts-expect-error wrong event payload
  api.emit('docs.cursor', { x: 'left' });
  api.on('state', (state) => {
    const known: 'connecting' | 'online' | 'offline' | 'closed' = state;
    void known;
  });
  void [opened, touched, parts];
}
void typeChecks;
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/contract.test.ts`
Expected: FAIL — `client.typed is not a function` (or TS2339 / `ERR_MODULE_NOT_FOUND` for `../src/contract.js`).

- [ ] **Step 3: Implement**

`packages/http-socket-client/src/contract.ts`:

```ts
import type { CommandName, CommandPayload, CommandResult, EventName, EventPayload, SocketContract } from '@spinajs/http-socket-common';
import type { ClientLifecycleEvents, LifecycleEventName, Unsubscribe } from './client.js';
import type { CommandOptions } from './commands.js';
import type { ConnectionState } from './connection.js';

/** A stream command declares its result as AsyncIterable<Item>; stream() yields the items. */
export type StreamItem<C extends SocketContract, N extends CommandName<C>> = CommandResult<C, N> extends AsyncIterable<infer T> ? T : CommandResult<C, N>;

/** A SocketClient seen through a contract: names and payloads are checked at compile time. */
export interface TypedSocketClient<C extends SocketContract> {
  readonly clientId: string;
  readonly state: ConnectionState;
  connect(): void;
  disconnect(): void;
  close(): void;
  command<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: CommandOptions): Promise<CommandResult<C, N>>;
  durable<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>): Promise<CommandResult<C, N>>;
  stream<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>, options?: CommandOptions): AsyncIterable<StreamItem<C, N>>;
  emit<N extends EventName<C>>(name: N, payload: EventPayload<C, N>): boolean;
  on<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  on<N extends EventName<C>>(event: N, listener: (payload: EventPayload<C, N>) => void): Unsubscribe;
  once<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): Unsubscribe;
  once<N extends EventName<C>>(event: N, listener: (payload: EventPayload<C, N>) => void): Unsubscribe;
  off<K extends LifecycleEventName>(event: K, listener: ClientLifecycleEvents[K]): void;
  off<N extends EventName<C>>(event: N, listener: (payload: EventPayload<C, N>) => void): void;
}
```

In `packages/http-socket-client/src/client.ts`, replace the first import line:

```ts
import type { EventFrame, SocketError } from '@spinajs/http-socket-common';
```

with:

```ts
import type { Contract, EventFrame, SocketContract, SocketError } from '@spinajs/http-socket-common';
```

and add, after the `import { Connection, … } from './connection.js';` line:

```ts
import type { TypedSocketClient } from './contract.js';
```

Then add this method to `SocketClient`, directly after `close()`:

```ts
  /** The same client, typed by a contract shared with the server; no runtime cost. */
  public typed<C extends SocketContract>(_contract: Contract<C>): TypedSocketClient<C> {
    return this as unknown as TypedSocketClient<C>;
  }
```

- [ ] **Step 4: Run the tests and the type check**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/contract.test.ts test/client.test.ts`
Expected: `12 passing` (1 + 11).

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0 (every `@ts-expect-error` in `test/contract.test.ts` is consumed by a real error).

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket-client/src/contract.ts packages/http-socket-client/src/client.ts packages/http-socket-client/test/contract.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): TypedSocketClient through client.typed(contract)"
```

---

### Task 11: Public entry, dual build, final verification

**Files:**
- Create: `packages/http-socket-client/src/index.ts`
- Test: `packages/http-socket-client/test/index.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the package entry. Public: everything from `@spinajs/http-socket-common`; `SocketClient`, `LIFECYCLE_EVENTS`, `SocketCommandError`, `isSocketError`, `ReconnectPolicy`, `DEFAULT_RECONNECT`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_CONNECT_TIMEOUT_MS`; types `SocketClientOptions`, `ClientLifecycleEvents`, `FailedCommand`, `LifecycleEventName`, `ServerEventListener`, `Unsubscribe`, `CommandOptions`, `WhenOffline`, `AuthPayload`, `AuthProvider`, `ConnectionState`, `IoOptions`, `ReconnectOptions`, `TypedSocketClient`, `StreamItem`. Internal (not exported): `Connection`, `CommandDispatcher`, `Emitter`, `WIRE`, `randomId`.

- [ ] **Step 1: Write the failing test**

`packages/http-socket-client/test/index.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import * as api from '../src/index.js';

describe('public entry', () => {
  it('exports the client surface and the common protocol', () => {
    for (const name of ['SocketClient', 'LIFECYCLE_EVENTS', 'SocketCommandError', 'isSocketError', 'ReconnectPolicy', 'DEFAULT_RECONNECT', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_CONNECT_TIMEOUT_MS', 'defineContract', 'PROTOCOL_VERSION']) {
      expect(api, name).to.have.property(name);
    }
  });

  it('keeps the internals private', () => {
    for (const name of ['Connection', 'CommandDispatcher', 'Emitter', 'WIRE', 'randomId']) {
      expect(api, name).to.not.have.property(name);
    }
  });

  it('ships the binding defaults', () => {
    expect(api.DEFAULT_RECONNECT).to.deep.equal({ minMs: 500, maxMs: 30_000, jitter: 0.3 });
    expect(api.DEFAULT_TIMEOUT_MS).to.equal(15_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/http-socket-client`): `npx ts-mocha -p tsconfig.json test/index.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/index.js`.

- [ ] **Step 3: Implement**

`packages/http-socket-client/src/index.ts`:

```ts
export * from '@spinajs/http-socket-common';
export { SocketClient, LIFECYCLE_EVENTS } from './client.js';
export type { ClientLifecycleEvents, FailedCommand, LifecycleEventName, ServerEventListener, SocketClientOptions, Unsubscribe } from './client.js';
export { DEFAULT_TIMEOUT_MS } from './commands.js';
export type { CommandOptions, WhenOffline } from './commands.js';
export { DEFAULT_CONNECT_TIMEOUT_MS } from './connection.js';
export type { AuthPayload, AuthProvider, ConnectionState, IoOptions } from './connection.js';
export type { StreamItem, TypedSocketClient } from './contract.js';
export { SocketCommandError, isSocketError } from './errors.js';
export { DEFAULT_RECONNECT, ReconnectPolicy } from './reconnect.js';
export type { ReconnectOptions } from './reconnect.js';
```

- [ ] **Step 4: Run the whole suite and the type check**

Run (in `packages/http-socket-client`): `npm test`
Expected: `70 passing`, `0 failing` (errors 4, ids 2, isomorphic 2, emitter 7, reconnect-policy 6, connection 6, connection-resilience 7, handshake-errors 4, commands 9, command-failures 8, client 11, contract 1, index 3), and the process exits on its own (a hang after the summary means a test leaked a socket or timer — fix it, do not add `--exit`).

Run (in `packages/http-socket-client`): `npm run typecheck`
Expected: exits 0.

Run (in `packages/http-socket-common`): `npm test`
Expected: `2 passing`.

- [ ] **Step 5: Build both flavours and smoke-test the published entry**

Run (worktree root):

```bash
node node_modules/typescript-7/lib/tsc.js -b packages/http-socket-common/tsconfig.mjs.json packages/http-socket-common/tsconfig.cjs.json packages/http-socket-client/tsconfig.mjs.json packages/http-socket-client/tsconfig.cjs.json
node scripts/generate-packages-for-modules.mjs
node -e "const c = require('@spinajs/http-socket-client'); console.log(typeof c.SocketClient, c.DEFAULT_TIMEOUT_MS, c.PROTOCOL_VERSION)"
node --input-type=module -e "const c = await import('@spinajs/http-socket-client'); console.log(typeof c.SocketClient, c.DEFAULT_TIMEOUT_MS, c.PROTOCOL_VERSION)"
```

Expected: the build exits 0; both smoke lines print `function 15000 1`.

Run (worktree root): `node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json`
Expected: exits 0. If it fails only inside packages W1 is still changing (`packages/http-socket`, `packages/http-socket-common` after a W1 edit), record the errors in the hand-off and do not touch those packages; the targeted build above is this task's gate.

- [ ] **Step 6: Commit**

```bash
git add packages/http-socket-client/src/index.ts packages/http-socket-client/test/index.test.ts
git branch --show-current | grep -qx feat/websocket-layer && git commit -m "feat(http-socket-client): public entry; dual esm/cjs build verified"
```

---

## Self-review notes (for the executor's reviewer)

- Spec §6/§8 W2 coverage: state machine + `'state'` (Tasks 5–6, 9), reconnect with backoff + jitter (Tasks 4, 6), auth on every (re)connect (Task 6), handshake `{protocol, clientId, token}` (Task 5), `unauthenticated` → `auth_required` and `version_mismatch` → `incompatible` (Task 6, forwarded in Task 9), `sys.shutdown` `retryAfterMs` (Task 6), plain commands with timeout, `AbortSignal` and `whenOffline` (Tasks 7–8), typed `SocketCommandError` (Task 2), events subscribe/unsubscribe (Task 9), typed contracts (Task 10), isomorphic main entry (Task 2 guard, Task 11 build). Durable commands, stores and streams are W3/W4; their names are reserved (Task 9) and their seams listed above.
- Additions the spec does not name, each with a reason in its task: `connectTimeoutMs` (Task 6), `disconnect()` (Task 5), `emit()` returning `false` offline (Task 9), `onListenerError` (Tasks 3, 9), `'wait'`-timeout → `unavailable` vs in-flight timeout → `deadline_exceeded` (Task 8).
