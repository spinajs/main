# Session Object Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SessionIssuer.restore()` returns a `Session` object instead of the anonymous `{ handle; identity; facts; data }` literal. The object reads its data through typed keys: a predefined set, open to extension. Helpers such as `activeRoleCeiling` read the session through these keys instead of raw map lookups.

**Architecture:** `@spinajs/authn/contracts` gains a new file, `session-state.ts`, holding:
- `SessionKey<T>`: a name plus a decoder from the stored value to `T`.
- `sessionKey()`: the factory apps use to define their own keys.
- `SessionKeys`: the frozen set of keys authn itself uses.
- `ImpersonationBlock`.
- `Session`: a concrete class holding `handle`, `identity`, `facts` and `data` as own readonly fields, with typed getters on its prototype.

Because the own fields keep the old shape, every reader of `.handle`, `.identity`, `.facts` and `.data` keeps compiling. Only places that build the literal must change: the issuers, test fakes, type aliases and literal stubs. Code that interprets data moves to the typed getters. Writes still go through `SessionIssuer.set(h, key.name, value)`.

**Tech Stack:** TypeScript (ESM + CJS builds), mocha via `ts-mocha`, chai / `node:assert/strict`, `@spinajs/util` guards.

## Global Constraints

- Write every comment, doc and identifier in English. Comment only what the code cannot say; no history comments.
- `packages/authn/src/contracts/**` may import at runtime only `@spinajs/di` and `@spinajs/util` (`ALLOWED_PACKAGES` in `packages/authn/test/contracts/boundary.test.ts:17`). Every other import there must be `import type`.
- `packages/authn/src/contracts/session.ts` must keep declaring only `SessionIssuer`. `credentials.test.ts:29` and `session.test.ts:168` pin this, so the new code goes in a new file.
- Keep the restore doc phrases asserted in `session.test.ts:205-207` (`A07`, `only a uuid v4 input falls back to a raw lookup`, `a stored hash never works as an id (SR-18)`).
- `Session` must not carry private state or methods as own properties. `issuer-peek.test.ts:46` deep-compares two restored sessions.
- Keep the stored data format unchanged. Key names (`ActiveRole`, `Impersonation`, `Ip`, `UserAgent`, `authn:pendingSteps`) and value shapes stay byte-identical, so existing rows keep working.
- The working tree has unrelated uncommitted changes. Each commit step stages only the files the task lists.
- Contract entry points are snapshotted: run `node scripts/api-snapshot.mjs` and commit the updated `packages/*/etc/*.api.md` (Task 4).
- After code changes, run `graphify update .` (project CLAUDE.md).

## Behaviour changes (intended)

- `GET auth/active-role` answers `ActiveRole: ''` instead of `null` for a stored value that no role switch writes (for example `42`). `null` claims that every held role applies, while the principal is in fact narrowed to no role. `''` is what `stop` already writes for "no role".
- Nothing else changes: decoders reproduce the checks they replace.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/authn/src/contracts/session-state.ts` (new) | `SessionKey`, `sessionKey`, `SessionKeys`, `ImpersonationBlock`, `Session`, `SessionInit` |
| `packages/authn/src/contracts/session.ts` | `restore` returns `Promise<Session \| null>` |
| `packages/authn/src/contracts/index.ts` | re-exports `session-state.js` |
| `packages/authn-session/src/issuer.ts` | builds `Session`; the key constants alias `SessionKeys` |
| `packages/authn-testing/src/fakes/sessions.ts` | `MemorySessionIssuer` builds `Session` |
| `packages/authn/src/impersonation/active-role.ts` | `activeRoleCeiling(session)` |
| `packages/authn/src/impersonation/impersonation-service.ts` | reads the block through `session.impersonation` |
| `packages/authn/src/service/default-authn-service.ts` | `Stored` alias becomes `Session` |
| `packages/authn-http/src/api.ts` | `AuthnSession?: Session \| null` |
| `packages/authn-http/src/v3/routes.ts`, controllers, resolvers, `mfa/fields.ts`, `keys/fields.ts`, `middleware/authn.ts` | the `Restored` aliases become `Session`; typed reads |

---

### Task 1: `Session` contract, with both issuers returning it

**Files:**
- Create: `packages/authn/src/contracts/session-state.ts`
- Modify: `packages/authn/src/contracts/session.ts:1-2,22`
- Modify: `packages/authn/src/contracts/index.ts` (one export line)
- Modify: `packages/authn-session/src/issuer.ts:9,17-29,51,139-177`
- Modify: `packages/authn-testing/src/fakes/sessions.ts:2-3,114-139`
- Test (create): `packages/authn/test/contracts/session-state.test.ts`
- Test (modify): `packages/authn/test/contracts/session.test.ts:8-20,47-50,263`
- Test (modify): `packages/authn/test/contracts/boundary.test.ts:18`

**Interfaces:**
- Produces (exported from `@spinajs/authn/contracts` and `@spinajs/authn`):
  - `interface SessionKey<T> { readonly name: string; decode(raw: unknown): T }`
  - `function sessionKey<T>(name: string, decode: (raw: unknown) => T): SessionKey<T>`
  - `interface ImpersonationBlock { readonly startedAt: Date; readonly actorRoles?: readonly string[] }`
  - `const SessionKeys: { ActiveRole: SessionKey<string | undefined>; Impersonation: SessionKey<ImpersonationBlock | null>; Ip: SessionKey<string | undefined>; UserAgent: SessionKey<string | undefined>; PendingSteps: SessionKey<readonly string[] | undefined> }`
  - `interface SessionInit { handle: SessionHandle; identity: IdentityRef; facts: AuthnFacts; data?: Iterable<readonly [string, unknown]> }`
  - `class Session`:
    - own fields `handle`, `identity`, `facts`, `data: ReadonlyMap<string, unknown>`
    - getters `state`, `impersonator`, `activeRole`, `impersonation`, `ip`, `userAgent`, `pendingSteps`
    - methods `has(key)` and `get<T>(key): T | undefined`
  - `SessionIssuer.restore(rawId: string): Promise<Session | null>`

- [ ] **Step 1: Write the failing test**

Create `packages/authn/test/contracts/session-state.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { Session, SessionKeys, sessionKey } from '../../src/contracts/session-state.js';
import * as index from '../../src/contracts/index.js';
import type { AuthnFacts } from '../../src/contracts/principal.js';

const expect = chai.expect;

const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) };
const session = (data: [string, unknown][] = [], state: 'pending' | 'active' = 'active') => new Session({ handle: { id: 's1', state }, identity: { type: 'user', id: 'u1' }, facts, data });
const AT = '2026-01-01T00:00:00.000Z';

describe('Session', () => {
  it('is exported from the contracts index', () => {
    expect(index.Session).to.eq(Session);
    expect(index.SessionKeys).to.eq(SessionKeys);
    expect(index.sessionKey).to.eq(sessionKey);
  });

  it('keeps handle, identity and facts, and a copy of the data', () => {
    const data = new Map<string, unknown>([['k', 1]]);
    const s = new Session({ handle: { id: 's1', state: 'active' }, identity: { type: 'user', id: 'u1' }, facts: { ...facts, impersonator: { type: 'user', id: 'admin' } }, data });
    data.set('k', 2);
    expect(s.data.get('k')).to.eq(1);
    expect(s.state).to.eq('active');
    expect(s.impersonator).to.deep.eq({ type: 'user', id: 'admin' });
    expect(new Session({ handle: { id: 's', state: 'pending' }, identity: { type: 'user', id: 'u' }, facts }).data.size).to.eq(0);
  });

  it('two sessions built alike deep-equal: no own state beyond the four fields', () => {
    expect(Object.keys(session([['k', 1]]))).to.deep.eq(['handle', 'identity', 'facts', 'data']);
    expect(session([['k', 1]])).to.deep.eq(session([['k', 1]]));
  });

  it('get answers undefined for an absent key and hands every present value to the decoder, null included', () => {
    const seen: unknown[] = [];
    const probe = sessionKey('Probe', (raw) => (seen.push(raw), 'decoded'));
    expect(session().get(probe)).to.eq(undefined);
    expect(session().has(probe)).to.eq(false);
    expect(session([['Probe', null]]).get(probe)).to.eq('decoded');
    expect(session([['Probe', 1]]).has(probe)).to.eq(true);
    expect(seen).to.deep.eq([null]);
  });

  it('ActiveRole: none when absent or null, the role for a non-empty string, no role for anything else', () => {
    expect(session().activeRole).to.eq(undefined);
    expect(session([['ActiveRole', null]]).activeRole).to.eq(undefined);
    expect(session([['ActiveRole', 'editor']]).activeRole).to.eq('editor');
    for (const bad of ['', 42, ['admin'], { role: 'admin' }, true]) expect(session([['ActiveRole', bad]]).activeRole, JSON.stringify(bad)).to.eq('');
  });

  it('Impersonation: an ISO or Date start and at most one actor role; anything else is null', () => {
    expect(session().impersonation).to.eq(undefined);
    expect(session([['Impersonation', { startedAt: AT }]]).impersonation).to.deep.eq({ startedAt: new Date(AT) });
    expect(session([['Impersonation', { startedAt: new Date(AT), actorRoles: ['user'] }]]).impersonation).to.deep.eq({ startedAt: new Date(AT), actorRoles: ['user'] });
    expect(session([['Impersonation', { startedAt: AT, actorRoles: [] }]]).impersonation).to.deep.eq({ startedAt: new Date(AT), actorRoles: [] });
    const bad: unknown[] = [null, 'x', [], { startedAt: 'nope' }, { startedAt: 5 }, { startedAt: AT, actorRoles: 'user' }, { startedAt: AT, actorRoles: [42] }, { startedAt: AT, actorRoles: [''] }, { startedAt: AT, actorRoles: ['a', 'b'] }, { startedAt: AT, actorRoles: null }];
    for (const b of bad) expect(session([['Impersonation', b]]).impersonation, JSON.stringify(b)).to.eq(null);
  });

  it('Ip, UserAgent and PendingSteps', () => {
    const s = session([['Ip', '203.0.113.5'], ['UserAgent', 'kit'], ['authn:pendingSteps', ['totp']]], 'pending');
    expect([s.ip, s.userAgent, s.pendingSteps]).to.deep.eq(['203.0.113.5', 'kit', ['totp']]);
    expect(Object.isFrozen(s.pendingSteps)).to.eq(true);
    expect(session([['Ip', '']]).ip).to.eq(undefined);
    expect(session([['authn:pendingSteps', []]]).pendingSteps).to.eq(undefined);
    expect(session([['authn:pendingSteps', ['totp', 1]]]).pendingSteps).to.eq(undefined);
  });

  it('SessionKeys is frozen and names the stored keys', () => {
    expect(Object.isFrozen(SessionKeys)).to.eq(true);
    expect(Object.isFrozen(SessionKeys.ActiveRole)).to.eq(true);
    expect(Object.values(SessionKeys).map((k) => k.name)).to.deep.eq(['ActiveRole', 'Impersonation', 'Ip', 'UserAgent', 'authn:pendingSteps']);
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run, from `packages/authn`: `npx ts-mocha -p tsconfig.json test/contracts/session-state.test.ts`
Expected: FAIL with `Cannot find module '../../src/contracts/session-state.js'`.

- [ ] **Step 3: Write `session-state.ts`**

Create `packages/authn/src/contracts/session-state.ts`:

```ts
import { isNonEmptyString, isPlainObject } from '@spinajs/util';

import type { IdentityRef } from './credentials.js';
import type { AuthnFacts, PrincipalRef } from './principal.js';
import type { SessionHandle } from './session.js';

/** A typed entry of session data. `decode` gets the stored value whenever the key is present, null included. */
export interface SessionKey<T> {
  readonly name: string;
  decode(raw: unknown): T;
}

export function sessionKey<T>(name: string, decode: (raw: unknown) => T): SessionKey<T> {
  return Object.freeze({ name, decode });
}

export interface ImpersonationBlock {
  readonly startedAt: Date;
  /** The role of the actor's role switch at start; [] when that switch narrowed to no role. */
  readonly actorRoles?: readonly string[];
}

const nonEmpty = (raw: unknown): string | undefined => (isNonEmptyString(raw) ? raw : undefined);

function activeRole(raw: unknown): string | undefined {
  if (raw === null) return undefined;
  // A value no role switch writes narrows to no role instead of lifting the narrowing.
  return isNonEmptyString(raw) ? raw : '';
}

function impersonationBlock(raw: unknown): ImpersonationBlock | null {
  if (!isPlainObject(raw)) return null;
  const started: unknown = typeof raw.startedAt === 'string' ? new Date(raw.startedAt) : raw.startedAt;
  if (!(started instanceof Date) || Number.isNaN(started.getTime())) return null;
  if (!('actorRoles' in raw)) return { startedAt: started };
  const roles: unknown = raw.actorRoles;
  // A role switch writes at most one role.
  if (!Array.isArray(roles) || roles.length > 1 || !roles.every(isNonEmptyString)) return null;
  return { startedAt: started, actorRoles: Object.freeze([...roles]) };
}

function pendingSteps(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string') ? Object.freeze([...raw]) : undefined;
}

/** The data keys authn reads. An app defines its own with `sessionKey` and reads them with `Session.get`. */
export const SessionKeys = Object.freeze({
  /** Written by a role switch (D14); '' narrows to no role. */
  ActiveRole: sessionKey('ActiveRole', activeRole),
  /** Written by impersonation start; null when it cannot be read. */
  Impersonation: sessionKey('Impersonation', impersonationBlock),
  Ip: sessionKey('Ip', nonEmpty),
  UserAgent: sessionKey('UserAgent', nonEmpty),
  /** Only on a pending session, from the issuer; `set` refuses it. */
  PendingSteps: sessionKey('authn:pendingSteps', pendingSteps),
});

export interface SessionInit {
  readonly handle: SessionHandle;
  readonly identity: IdentityRef;
  readonly facts: AuthnFacts;
  readonly data?: Iterable<readonly [string, unknown]>;
}

/** A restored session. Read data through a SessionKey; `data` holds the raw public entries. */
export class Session {
  public readonly handle: SessionHandle;
  public readonly identity: IdentityRef;
  public readonly facts: AuthnFacts;
  public readonly data: ReadonlyMap<string, unknown>;

  constructor(init: SessionInit) {
    this.handle = init.handle;
    this.identity = init.identity;
    this.facts = init.facts;
    this.data = new Map(init.data ?? []);
  }

  public get state(): SessionHandle['state'] {
    return this.handle.state;
  }

  public get impersonator(): PrincipalRef | undefined {
    return this.facts.impersonator;
  }

  public get activeRole(): string | undefined {
    return this.get(SessionKeys.ActiveRole);
  }

  /** undefined without a block (a migrated 2.x session), null for one that cannot be read. */
  public get impersonation(): ImpersonationBlock | null | undefined {
    return this.get(SessionKeys.Impersonation);
  }

  public get ip(): string | undefined {
    return this.get(SessionKeys.Ip);
  }

  public get userAgent(): string | undefined {
    return this.get(SessionKeys.UserAgent);
  }

  public get pendingSteps(): readonly string[] | undefined {
    return this.get(SessionKeys.PendingSteps);
  }

  public has(key: SessionKey<unknown>): boolean {
    return this.data.has(key.name);
  }

  public get<T>(key: SessionKey<T>): T | undefined {
    return this.data.has(key.name) ? key.decode(this.data.get(key.name)) : undefined;
  }
}
```

In `packages/authn/src/contracts/index.ts`, add this directly after the `export * from './session.js';` line:

```ts
export * from './session-state.js';
```

- [ ] **Step 4: Run the test and check that it passes**

Run, from `packages/authn`: `npx ts-mocha -p tsconfig.json test/contracts/session-state.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Change the contract and its contract tests**

In `packages/authn/src/contracts/session.ts`, add this import after the existing two `import type` lines:

```ts
import type { Session } from './session-state.js';
```

Replace line 22 and keep its doc comment unchanged:

```ts
  abstract restore(rawId: string): Promise<Session | null>;
```

In `packages/authn/test/contracts/session.test.ts`:
- Add `import { Session } from '../../src/contracts/session-state.js';` after line 9.
- Delete the `type Restored = ...` line (line 20).
- Replace `MemoryIssuer.restore` (lines 47-50) with:

```ts
  async restore(rawId: string): Promise<Session | null> {
    const r = this.rows.find((x) => x.id === rawId);
    return r ? new Session({ handle: { id: r.id, state: r.state }, identity: r.identity, facts: r.facts, data: r.data }) : null;
  }
```

- In `members have the design types`, replace line 223 with `same<ReturnType<SessionIssuer['restore']>, Promise<Session | null>>(true);`.
- In `NoRevokeAll` (line 263), change the return type to `Promise<Session | null>`.

In `packages/authn/test/contracts/boundary.test.ts:18`, append `'Session', 'SessionKeys', 'sessionKey'` to `RUNTIME_EXPORTS`.

- [ ] **Step 6: Make `DefaultSessionIssuer` return `Session`**

In `packages/authn-session/src/issuer.ts`:
- Line 9 becomes `import { Session, SessionIssuer, SessionKeys } from '@spinajs/authn/contracts';`.
- Keep the doc comments on the three key constants, and change their values:

```ts
export const SESSION_IP_KEY = SessionKeys.Ip.name;
export const SESSION_USER_AGENT_KEY = SessionKeys.UserAgent.name;
export const SESSION_PENDING_STEPS_KEY = SessionKeys.PendingSteps.name;
```

- Delete `type Restored = ...` (line 51), then remove `IdentityRef` from the type import on line 10 only if `tsc` reports it unused.
- `peek` and `restore` return `Promise<Session | null>`.
- Replace the `return { ... }` at lines 171-176 with:

```ts
    return new Session({
      handle: { id: rawId, state: session.State },
      identity: ref(session.Subject),
      facts: this.factsOf(session, stored),
      data: this.publicData(session),
    });
```

- [ ] **Step 7: Make `MemorySessionIssuer` return `Session`**

In `packages/authn-testing/src/fakes/sessions.ts`:
- Line 2 becomes `import { Session, SessionIssuer } from '@spinajs/authn/contracts';`.
- The `restore` signature (line 114) becomes `async restore(rawId: string): Promise<Session | null> {`.
- Line 138 becomes:

```ts
    return new Session({ handle: { id: rawId, state: row.state }, identity: row.subject, facts: row.facts, data: row.data });
```

The constructor copies `data`, so the old `new Map(row.data)` copy is no longer needed.

- [ ] **Step 8: Build and run the three packages in dependency order**

Run each from the repo root. `pretest` builds each package before its tests run:

```bash
cd packages/authn && npm test
cd ../authn-session && npm test
cd ../authn-testing && npm test
```

Expected: all pass.
- If `authn` fails only in suites that use `@spinajs/authn-testing` fakes, the cause is the stale `authn-testing` lib. Rerun `cd packages/authn && npm test` after `authn-testing` has built.
- A `deepStrictEqual` of a whole restored session against an object literal would now fail on the prototype. A search found none; if one appears, compare the fields instead.

- [ ] **Step 9: Commit**

```bash
git add packages/authn/src/contracts/session-state.ts packages/authn/src/contracts/session.ts packages/authn/src/contracts/index.ts packages/authn/test/contracts/session-state.test.ts packages/authn/test/contracts/session.test.ts packages/authn/test/contracts/boundary.test.ts packages/authn-session/src/issuer.ts packages/authn-testing/src/fakes/sessions.ts
git commit -m "feat(authn): restore returns a Session with typed data keys"
```

---

### Task 2: authn reads session data through `Session`

**Files:**
- Modify: `packages/authn/src/impersonation/active-role.ts` (whole file)
- Modify: `packages/authn/src/impersonation/impersonation-service.ts:21-25,36,46,81-86,191,263-303` and every `Stored` in the file
- Modify: `packages/authn/src/service/default-authn-service.ts:40,501` and every `Stored` in the file
- Modify: `packages/authn/src/impersonation/README.md:24,29-30`
- Test: `packages/authn/test/impersonation/impersonation-service.test.ts:632-639,705,740`

**Interfaces:**
- Consumes: `Session`, `SessionKeys`, `ImpersonationBlock` from Task 1.
- Produces:
  - `activeRoleCeiling(session: Pick<Session, 'activeRole'>): Ceiling | undefined`. This replaces the old `(data: ReadonlyMap<string, unknown>)` signature.
  - `ACTIVE_ROLE_KEY === 'ActiveRole'` and `IMPERSONATION_BLOCK === 'Impersonation'`, unchanged and still exported.

- [ ] **Step 1: Change the `activeRoleCeiling` test to take a session (failing)**

In `packages/authn/test/impersonation/impersonation-service.test.ts`:
- Add `import { Session } from '../../src/contracts/session-state.js';` to the imports.
- Replace the test at lines 632-639 with:

```ts
    it('activeRoleCeiling: none before a switch, the role after one, no role for a value no switch writes', () => {
      const withRole = (...raw: unknown[]) => new Session({ handle: { id: 'x', state: 'active' }, identity: { type: 'user', id: 'u' }, facts: { method: 'password', strategy: 'local', assurance: 'aal2', mfa: [], authenticatedAt: T0 }, data: raw.map((v) => [ACTIVE_ROLE_KEY, v] as const) });
      assert.strictEqual(activeRoleCeiling(withRole()), undefined);
      assert.strictEqual(activeRoleCeiling(withRole(null)), undefined);
      assert.deepStrictEqual(activeRoleCeiling(withRole('user')), { roles: ['user'] });
      for (const bad of ['', 42, ['admin'], { role: 'admin' }, true]) {
        assert.deepStrictEqual(activeRoleCeiling(withRole(bad)), { roles: [] }, JSON.stringify(bad));
      }
    });
```

- Line 705 becomes `assert.deepStrictEqual(activeRoleCeiling(stored!), { roles: ['user'] });`.
- Line 740 becomes `assert.deepStrictEqual(activeRoleCeiling((await p.sessions.restore(back.id))!), { roles: [] });`.

- [ ] **Step 2: Run the test and check that it fails**

Run, from `packages/authn`: `npx ts-mocha -p tsconfig.json test/impersonation/impersonation-service.test.ts`
Expected: FAIL at compile time with `Argument of type 'Session' is not assignable to parameter of type 'ReadonlyMap<string, unknown>'`.

- [ ] **Step 3: Rewrite `active-role.ts`**

```ts
import { SessionKeys } from '../contracts/session-state.js';
import type { Session } from '../contracts/session-state.js';
import type { Ceiling } from '../contracts/principal.js';

/** Session data key of the role chosen by a role switch (D14). */
export const ACTIVE_ROLE_KEY = SessionKeys.ActiveRole.name;

/** `ceiling.roles = [ActiveRole]` after a role switch (D14); undefined before any. */
export function activeRoleCeiling(session: Pick<Session, 'activeRole'>): Ceiling | undefined {
  const role = session.activeRole;
  if (role === undefined) return undefined;
  return { roles: role === '' ? [] : [role] };
}
```

- [ ] **Step 4: Move the impersonation service onto `Session`**

In `packages/authn/src/impersonation/impersonation-service.ts`:

1. Add the imports `import { SessionKeys } from '../contracts/session-state.js';` and `import type { Session } from '../contracts/session-state.js';`.
2. Keep the doc comment at lines 21-24, and change line 25 to `export const IMPERSONATION_BLOCK = SessionKeys.Impersonation.name;`.
3. Delete `type Stored = ...` (line 36). Replace every remaining `Stored` type reference in the file with `Session`: in the `restore`, `live`, `block`, `end`, `handleOf` and `startRefusal` signatures.
4. Delete `blockCeiling` (lines 81-86) together with its doc comment.
5. Line 191 becomes `const actorCeiling = activeRoleCeiling(stored);`.
6. The private `restore` returns `Promise<Session | null>`; its body is unchanged.
7. Replace `block()` (the doc comment stays as it is) with:

```ts
  private block(stored: Session, ctx: AuthnContext): Block | null {
    const authenticated = stored.facts.authenticatedAt;
    if (!validDate(authenticated)) return null;
    const block = stored.impersonation;
    if (block === undefined) return { startedAt: authenticated };
    if (block === null) return null;
    const t = block.startedAt.getTime();
    const skew: unknown = this.Settings.clockSkewSeconds;
    if (!Number.isFinite(skew) || (skew as number) < 0) return null;
    const skewMs = (skew as number) * 1000;
    if (t > ctx.now.getTime() + skewMs || t < authenticated.getTime() - skewMs) return null;
    return { startedAt: block.startedAt, ...(block.actorRoles ? { actorCeiling: { roles: [...block.actorRoles] } } : {}) };
  }
```

8. Remove `isPlainObject` from the `@spinajs/util` import only if `tsc` reports it unused; `denial()` still uses it.

- [ ] **Step 5: `default-authn-service.ts`**

- Replace line 40 (`type Stored = NonNullable<Awaited<ReturnType<SessionIssuer['restore']>>>;`) with `import type { Session } from '../contracts/session-state.js';`, placed with the other imports.
- Replace every `Stored` type reference in the file with `Session`; line 501 is one of them.
- Keep the `SessionIssuer` import; the class still resolves it.

- [ ] **Step 6: README**

In `packages/authn/src/impersonation/README.md`:
- Replace the `ACTIVE_ROLE_KEY` bullet (lines 29-30) with: `` `ACTIVE_ROLE_KEY` and `activeRoleCeiling(session)`: the role chosen by a role switch (`session.activeRole`), as a ceiling `{ roles: [role] }` that narrows the principal. ``
- Append to the `IMPERSONATION_BLOCK` bullet (line 24): `` `session.impersonation` reads it. ``

- [ ] **Step 7: Run the authn tests and check that they pass**

Run, from `packages/authn`: `npm test`
Expected: PASS. This includes the impersonation suite (the `invalid_block` cases at lines 744-760 cover the decoder) and the contracts boundary test.

- [ ] **Step 8: Commit**

```bash
git add packages/authn/src/impersonation/active-role.ts packages/authn/src/impersonation/impersonation-service.ts packages/authn/src/service/default-authn-service.ts packages/authn/src/impersonation/README.md packages/authn/test/impersonation/impersonation-service.test.ts
git commit -m "refactor(authn): read the role switch and impersonation block through Session"
```

---

### Task 3: authn-http takes `Session` on request storage

**Files:**
- Modify: `packages/authn-http/src/api.ts:1,14`
- Modify: `packages/authn-http/src/middleware/authn.ts:19,147`
- Modify: `packages/authn-http/src/v3/routes.ts:7,17,110-112`
- Modify: `packages/authn-http/src/resolvers/session.ts:3-5,10,20-25,46,60`
- Modify: `packages/authn-http/src/v3/controllers/AuthnActiveRoleController.ts:12,36-39,76,83`
- Modify: `packages/authn-http/src/v3/controllers/AuthnImpersonationController.ts:18-19,45-51`
- Modify: the importers of `Restored` from `routes.ts`, namely `AuthnTokensController.ts:13`, `AuthnSessionsController.ts:11`, `AuthnMfaEnrolmentController.ts:14`, `mfa/fields.ts:11` and `keys/fields.ts:12`
- Test: `packages/authn-http/test/v3/authn-middleware.test.ts:969,985`
- Test: `packages/authn-http/test/authn-api-contract.test.ts:65,428`
- Test: `packages/authn-http/test/v3/mfa-policy-config.test.ts:19`

**Interfaces:**
- Consumes: `Session` from Task 1, and `activeRoleCeiling(session: Pick<Session, 'activeRole'>)` from Task 2.
- Produces:
  - `IActionLocalStoregeContext.AuthnSession?: Session | null`
  - `narrowedBySwitch(container, session: Pick<Session, 'identity' | 'facts' | 'activeRole'>, principal)`
  - `pendingSteps(container, session: Session, policyService)`

- [ ] **Step 1: Update the tests to expect `Session` (failing)**

In `packages/authn-http/test/authn-api-contract.test.ts`:
- Delete the `RestoredSession` alias (line 65).
- Add `Session` to the `@spinajs/authn/contracts` import. If `Session` is not exported by name from there yet, the import fails, which is the intended failure.
- Line 428 becomes `same<Request['storage']['AuthnSession'], Session | null | undefined>(true);`.

In `packages/authn-http/test/v3/mfa-policy-config.test.ts`:
- Add `import { Session } from '@spinajs/authn/contracts';`.
- Line 19 becomes:

```ts
const session = (stored?: unknown) => new Session({ handle: { id: 'x', state: 'pending' }, identity: { type: 'user', id: 'u1' }, facts: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(0) }, data: [[SESSION_PENDING_STEPS_KEY, stored]] });
```

In `packages/authn-http/test/v3/authn-middleware.test.ts`:
- Add `Session` to the `@spinajs/authn/contracts` import.
- Line 969 becomes `const pending = new Session({ handle: { id: 'x', state: 'pending' }, identity: { type: 'user', id: 'u' }, facts: FACTS() });`.
- Line 985 becomes:

```ts
      const active = (identity: IdentityRef, impersonator?: IdentityRef) => ({ storage: { AuthnSession: new Session({ handle: { id: 'x', state: 'active' }, identity, facts: FACTS(impersonator ? { impersonator } : {}) }) } }) as unknown as Request;
```

- [ ] **Step 2: Run the tests and check that they fail**

Run, from `packages/authn-http`: `npx ts-mocha -p tsconfig.json test/authn-api-contract.test.ts`
Expected: FAIL. The `same<...>` line does not compile, because `AuthnSession` is still typed from the `restore` return type.

- [ ] **Step 3: Request storage type and middleware**

In `packages/authn-http/src/api.ts`:
- Line 1: add `Session` to the type import, and remove `SessionIssuer` if nothing else in the file uses it.
- Line 14 becomes `AuthnSession?: Session | null;`.

In `packages/authn-http/src/middleware/authn.ts`:
- Delete line 19 (`type Restored = ...`).
- Import `type { Session }` from `@spinajs/authn/contracts`.
- Line 147 becomes `protected async restoreSession(req: Request): Promise<Session | null> {`.

- [ ] **Step 4: Remove the `Restored` alias from `routes.ts`**

In `packages/authn-http/src/v3/routes.ts`:
- Delete line 17 (`export type Restored = ...`).
- Add `Session` to the type import on line 6.
- Replace `Restored` with `Session` in `auditEnded` and `pendingSteps`.
- Line 7 becomes `import { SESSION_IP_KEY, SESSION_USER_AGENT_KEY } from '@spinajs/authn-session';`.
- Replace lines 111-112 with:

```ts
  const stored = session.pendingSteps;
  if (stored) return [...stored];
```

In each file that imported `type { Restored } from '../routes.js'` or `'../v3/routes.js'`, namely
`AuthnTokensController.ts`, `AuthnSessionsController.ts`, `AuthnMfaEnrolmentController.ts`, `AuthnActiveRoleController.ts`, `src/mfa/fields.ts` and `src/keys/fields.ts`:
- drop that import,
- add `Session` to the file's `import type { ... } from '@spinajs/authn/contracts'`, or add the line if the file has none,
- rename every `Restored` to `Session`.

- [ ] **Step 5: Resolver**

In `packages/authn-http/src/resolvers/session.ts`:
- Delete line 10 (`type Restored = ...`).
- Add `Session` to the type import on line 5.
- Replace `Restored` with `Session` in `principalOfSession` and `endRefused`.
- Replace `narrowedBySwitch` with:

```ts
export async function narrowedBySwitch(container: IContainer, session: Pick<Session, 'identity' | 'facts' | 'activeRole'>, principal: Principal): Promise<Principal> {
  const ceiling = activeRoleCeiling(session);
  if (!ceiling) return principal;
  const factory = await container.resolve(PrincipalFactory);
  return factory.principalOf(session.identity, session.facts, { ceiling });
}
```

Add `Session` to the `@spinajs/authn/contracts` type import (line 5). `endRefused` may read `session.impersonator` instead of `session.facts.impersonator`, but leave it: `facts.impersonator` is equally clear.

- [ ] **Step 6: Typed reads in the two controllers**

In `AuthnActiveRoleController.ts`:
- Remove the `ACTIVE_ROLE_KEY` import (line 9) only if line 68 no longer uses it. Line 68 still writes with it, so keep it.
- Replace lines 37-39 with:

```ts
    const session = this.own(req);
    return new Ok({ ActiveRole: session.activeRole ?? null, Roles: await this.held(session) }, { Headers: [NO_STORE] });
```

In `AuthnImpersonationController.ts`:
- Delete the local `IMPERSONATION_BLOCK` constant and its doc comment (lines 18-19).
- Replace lines 45-53 (from `const block = ...` up to the `Ok` body) with:

```ts
    const startedAt = req.storage.AuthnSession?.impersonation?.startedAt;
    return new Ok(
      {
        Active: true,
        Impersonator: { type: impersonator.type, id: impersonator.id },
        Target: { type: principal.type, id: principal.id },
        ...(startedAt ? { StartedAt: startedAt.toISOString() } : {}),
      },
      { Headers: [NO_STORE] },
    );
```

The service writes `startedAt` with `toISOString()`, and parsing it back and serialising it again gives the same string.

- [ ] **Step 7: Run the authn-http tests and check that they pass**

Run, from `packages/authn-http`: `npm test`
Expected: PASS for all three mocha configs (unit, `v3-app`, `v3-socket`). Look in particular at the `v3-app` suites `impersonation.ts` and `active-role.ts`.

- [ ] **Step 8: Run the downstream packages**

Run `npm test` in `packages/authn-oidc`, `packages/authn-totp`, `packages/authn-local`, `packages/users` and `packages/authz-http`.
Expected: PASS. These packages only read `.handle`, `.identity`, `.facts` and `.data`, which are unchanged. A failure there means a literal stub of the old shape was missed: replace it with `new Session({...})`.

- [ ] **Step 9: Commit**

```bash
git add packages/authn-http/src packages/authn-http/test/v3/authn-middleware.test.ts packages/authn-http/test/authn-api-contract.test.ts packages/authn-http/test/v3/mfa-policy-config.test.ts
git commit -m "refactor(authn-http): type request storage AuthnSession as Session"
```

Before staging, run `git status packages/authn-http/src` and stage only the files this task changed. `src` already holds unrelated work in progress (see the session start status).

---

### Task 4: API snapshots and graph

**Files:**
- Modify (generated): `packages/authn/etc/authn.api.md`, `packages/authn-http/etc/authn-http.api.md`, `packages/authn-session/etc/*.api.md`, `packages/authn-testing/etc/*.api.md` (whichever the script rewrites)

- [ ] **Step 1: Regenerate the snapshots**

Run, from the repo root: `node scripts/api-snapshot.mjs`
Then: `node scripts/api-snapshot.mjs --check`
Expected: `--check` exits 0.
The diff should show:
- `Session`, `SessionKey`, `sessionKey`, `SessionKeys`, `SessionInit` and `ImpersonationBlock` added,
- `restore(...): Promise<Session | null>`,
- `activeRoleCeiling(session: Pick<Session, "activeRole">)`,
- `AuthnSession?: Session | null`.

- [ ] **Step 2: Update the graph**

Run: `graphify update .`
Expected: completes without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/authn/etc packages/authn-http/etc packages/authn-session/etc packages/authn-testing/etc graphify-out
git commit -m "chore: refresh API snapshots and graph for Session"
```

---

## Out of scope (follow-ups)

- **Typed writes:** `SessionIssuer.set(h, key: SessionKey<T>, value: T)`. Every implementer would have to change; today callers pass `SessionKeys.X.name`.
- **`peek` on the contract:** already tracked in `packages/http-socket/RELEASE_NOTES.md:294`.
- **Reserved keys:** `MemorySessionIssuer` and `DefaultSessionIssuer` refuse different reserved key sets.
