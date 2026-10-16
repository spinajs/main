# Session Class Through DI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An app can replace the `Session` class with its own subclass by registering it in the DI container, for example `container.register(AppSession).as(Session)`. Every session that authn builds is then an `AppSession`, a new instance per restore.

**Architecture:**
- `Session` gets `@NewInstance()`. It is still not registered at load time, because the contracts boundary test forbids load-time DI registrations.
- A new contracts helper, `resolveSession(container, value)`, has two paths:
  - When `value` is already a `Session`, it returns it unchanged.
  - Otherwise it resolves `Session` from the container with `[init]` as the constructor argument. `getCurrentType` falls back to `Session` itself when nothing is registered, so the result is `new Session(init)` by default and the app's class when one is registered.
- The helper guards the two failure modes of NewInstance resolution, following the precedent of `FlowLimiter` in `packages/authn/src/throttle/memory-throttle.ts:125-135`:
  - A subclass that depends on an AsyncService resolves to a Promise.
  - A subclass that lost NewInstance resolves to a cached instance that ignores the args.
- All five places that build a session call the helper.

**Tech Stack:** TypeScript, `@spinajs/di` (`resolve(Type, [args])`, `@NewInstance()`), and mocha with chai via ts-mocha.

## Global Constraints

- Write all comments, docs and identifiers in English. Comment only what the code cannot say.
- `packages/authn/src/contracts/**` may import at runtime only `@spinajs/di` and `@spinajs/util`. Errors raised there are plain `Error`, because `@spinajs/exceptions` is not allowed.
- Loading the contracts must not change the DI registry, cache or events. `boundary.test.ts:198,202` compares a DI snapshot taken before and after the load. So the plan uses `@NewInstance()`, which writes only metadata. **No `@Injectable()` on `Session`.**
- `Session` keeps no own state beyond `handle`, `identity`, `facts` and `data`.
- The stored data format stays unchanged.
- **Shared working tree.** Another session has uncommitted edits, including `packages/authn/src/impersonation/impersonation-service.ts`, which it is moving from `@Inject(Container)` to `@Autoinject` fields.
  - Stage only your own hunks.
  - `git stash` and `git add -A` / `git add .` are forbidden.
  - Execute Task 2 Step 6 after that session commits, or commit only your hunk.
- API snapshots: regenerate with `node scripts/api-snapshot.mjs`, but commit only this change's hunks. Gate G1 has passed, so add the RFC `docs/plans/authz-v3-rfc/SO-2.md`.
- After code changes, run `graphify update .`.

## Subclass contract (goes into the docs)

- Write the constructor as `constructor(init: SessionInit)` and call `super(init)`. Constructor `@Inject` dependencies are passed **before** the resolve args, which would shift `init`, so do not use them.
- Any DI decorator on the subclass, such as `@Autoinject` or `@Config`, gives the subclass its own descriptor, which defaults to Singleton. So **re-declare `@NewInstance()`** on any subclass that has one.
- The subclass must not depend on an `AsyncService`, because session construction is synchronous.
- Read app keys with getters over `this.get(key)`. Consumers narrow with `req.storage.AuthnSession as AppSession`, or check with `instanceof AppSession`.
- Register the subclass in the container that serves requests:
  - `DI.register(AppSession).as(Session)` (the root container), or
  - `child.register(AppSession).as(Session)`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/authn/src/contracts/session-state.ts` | `@NewInstance()` on `Session`; new `resolveSession(container, value)` |
| `packages/authn/test/contracts/session-state.test.ts` | resolution, subclass and guard tests |
| `packages/authn/test/contracts/boundary.test.ts` | `RUNTIME_EXPORTS` gains `resolveSession` |
| `packages/authn-session/src/issuer.ts` | `@Autoinject(Container)`; `restore` builds through `resolveSession` |
| `packages/authn-testing/src/fakes/sessions.ts` | `MemorySessionOptions.container`, defaulting to `DI.RootContainer` |
| `packages/authn-http/src/middleware/authn.ts`, `src/socket/session-source.ts` | wrapping goes through `resolveSession(this.Container, …)` |
| `packages/authn/src/impersonation/impersonation-service.ts` | wrapping goes through `resolveSession` |
| `packages/authn-session/README.md`, `docs/plans/authz-v3-rfc/SO-2.md` | the subclass contract |

---

### Task 1: `Session` resolvable through DI

**Files:**
- Modify: `packages/authn/src/contracts/session-state.ts`
- Test: `packages/authn/test/contracts/session-state.test.ts`
- Test: `packages/authn/test/contracts/boundary.test.ts:18`

**Interfaces:**
- Produces:
  - `function resolveSession(container: IContainer, value: Session | SessionInit): Session`, exported from `@spinajs/authn/contracts`.
  - `Session` decorated with `@NewInstance()`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/authn/test/contracts/session-state.test.ts`, and add the imports to its import block: `import { DI, NewInstance, Singleton } from '@spinajs/di';` and `resolveSession` from `'../../src/contracts/session-state.js'`.

```ts
describe('resolveSession', () => {
  const init = (id: string) => ({ handle: { id, state: 'active' as const }, identity: { type: 'user', id: 'u1' }, facts, data: [['ActiveRole', 'editor']] as [string, unknown][] });

  @NewInstance()
  class AppSession extends Session {
    public get theme(): string | undefined {
      return this.get(sessionKey('Theme', (raw) => (typeof raw === 'string' ? raw : undefined)));
    }
  }

  @Singleton()
  class SharedSession extends Session {}

  it('builds a plain Session when nothing is registered, a new one per call', () => {
    const c = DI.RootContainer.child();
    const a = resolveSession(c, init('a'));
    const b = resolveSession(c, init('b'));
    expect(a.constructor).to.eq(Session);
    expect([a.handle.id, b.handle.id, a.activeRole]).to.deep.eq(['a', 'b', 'editor']);
  });

  it('hands back a Session unchanged', () => {
    const s = new Session(init('s'));
    expect(resolveSession(DI.RootContainer.child(), s)).to.eq(s);
  });

  it('builds the class registered as Session in that container', async () => {
    const c = DI.RootContainer.child();
    c.register(AppSession).as(Session);
    const s = resolveSession(c, { ...init('x'), data: [['Theme', 'dark']] });
    expect(s).to.be.instanceOf(AppSession);
    expect((s as AppSession).theme).to.eq('dark');
    expect(resolveSession(DI.RootContainer.child(), init('y')).constructor).to.eq(Session);
    await c.dispose();
  });

  it('refuses a registered class that hands back one shared instance', async () => {
    const c = DI.RootContainer.child();
    c.register(SharedSession).as(Session);
    resolveSession(c, init('first'));
    expect(() => resolveSession(c, init('second'))).to.throw(/@NewInstance\(\)/);
    await c.dispose();
  });

  it('refuses a registration that is no Session', async () => {
    const c = DI.RootContainer.child();
    c.register({ NotASession: () => ({ handle: { id: 'z', state: 'active' } }) }.NotASession).as(Session);
    expect(() => resolveSession(c, init('z'))).to.throw(/not a Session/);
    await c.dispose();
  });
});
```

If `@Singleton()` is not exported by `@spinajs/di` under that name, check `packages/di/src/decorators.ts` and use the decorator it does export for the Singleton resolver. Any subclass that carries a DI decorator other than `@NewInstance()` resolves as a singleton.

In `packages/authn/test/contracts/boundary.test.ts:18`, append `'resolveSession'` to `RUNTIME_EXPORTS`.

- [ ] **Step 2: Run the tests and check that they fail**

Run, from `packages/authn`: `npx ts-mocha -p tsconfig.json test/contracts/session-state.test.ts --grep resolveSession`
Expected: FAIL with `resolveSession` not exported (TS2305), or not a function.

- [ ] **Step 3: Implement**

In `packages/authn/src/contracts/session-state.ts`:
- Add the imports `import { NewInstance } from '@spinajs/di';` and `import type { IContainer } from '@spinajs/di';`.
- Put `@NewInstance()` directly above `export class Session`.
- After the class, add:

```ts
/**
 * `value` itself when it is a Session, else the class registered as Session in `container` (Session when none is),
 * built from `value`. A registered class must be @NewInstance() and must not depend on an AsyncService.
 */
export function resolveSession(container: IContainer, value: Session | SessionInit): Session {
  if (value instanceof Session) return value;
  const session: unknown = container.resolve(Session, [value]);
  if (!(session instanceof Session)) {
    throw new Error('authn: the class registered as Session resolved to a value that is not a Session (an AsyncService dependency resolves to a Promise)');
  }
  // A singleton registration ignores the constructor arguments and hands back the first session again.
  if (session.handle !== value.handle) {
    throw new Error(`authn: declare @NewInstance() on ${session.constructor.name}; a shared instance would hand one session to every request`);
  }
  return session;
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run, from `packages/authn`: `npx ts-mocha -p tsconfig.json test/contracts/session-state.test.ts`
Expected: PASS, with all earlier Session tests plus 5 new ones.

Then run, from `packages/authn`: `npm run compile && npm run compile:cjs && npx ts-mocha -p tsconfig.json test/contracts/boundary.test.ts`
Expected: PASS. The DI snapshot before and after loading the contracts stays equal, which proves `@NewInstance()` registers nothing. If the snapshot differs, STOP and report: the decorator wrote to the registry, cache or events, and the design needs a different hook.

- [ ] **Step 5: Commit**

```bash
git add packages/authn/src/contracts/session-state.ts packages/authn/test/contracts/session-state.test.ts packages/authn/test/contracts/boundary.test.ts
git commit -m "feat(authn): Session resolves through DI so an app can register its own class"
```

---

### Task 2: Every build site resolves the session class

**Files:**
- Modify: `packages/authn-session/src/issuer.ts` (imports, a new `Container` field, the `restore` return)
- Modify: `packages/authn-testing/src/fakes/sessions.ts` (`MemorySessionOptions`, the constructor, the `restore` return)
- Modify: `packages/authn-http/src/middleware/authn.ts:165`
- Modify: `packages/authn-http/src/socket/session-source.ts:66`
- Modify: `packages/authn/src/impersonation/impersonation-service.ts` (private `restore`)
- Test: `packages/authn-session/test/issuer.test.ts`
- Test: `packages/authn-testing/test/fakes/sessions.test.ts`
- Test: `packages/authn-http/test/v3/authn-middleware.test.ts`

**Interfaces:**
- Consumes: `resolveSession(container, value)` from Task 1.
- Produces: `MemorySessionOptions.container?: IContainer`, which defaults to `DI.RootContainer`.

- [ ] **Step 1: Write the failing issuer test**

In `packages/authn-session/test/issuer.test.ts`, add a test that follows the file's setup. The setup resolves `DefaultSessionIssuer` from `DI`, uses `withSessionConfig` and `uncacheOwned` from `./support.js`, and has a `ref` fixture.

```ts
  it('restore builds the class registered as Session', async () => {
    @NewInstance()
    class AppSession extends Session {}
    DI.register(AppSession).as(Session);
    try {
      const issuer = await DI.resolve(DefaultSessionIssuer);
      const h = await issuer.issue({ type: 'user', id: 'u-app' }, FACTS);
      const restored = await issuer.restore(h.id);
      expect(restored).to.be.instanceOf(AppSession);
      expect(restored!.identity).to.deep.eq({ type: 'user', id: 'u-app' });
    } finally {
      DI.unregister(AppSession);
    }
  });
```

- Use the facts fixture the file already has; it may not be called `FACTS`.
- Add `Session` to the `@spinajs/authn/contracts` import and `NewInstance` to the `@spinajs/di` import.
- If the file's issuer comes from a fresh container per test (`withSessionConfig`), register on that container instead of `DI`.

In `packages/authn-testing/test/fakes/sessions.test.ts`, add:

```ts
  it('restore builds the class registered as Session in its container', async () => {
    @NewInstance()
    class AppSession extends Session {}
    const container = DI.RootContainer.child();
    container.register(AppSession).as(Session);
    const issuer = new MemorySessionIssuer({ container });
    const h = await issuer.issue({ type: 'user', id: 'u1' }, facts);
    expect(await issuer.restore(h.id)).to.be.instanceOf(AppSession);
    const plain = new MemorySessionIssuer();
    expect((await plain.restore((await plain.issue({ type: 'user', id: 'u1' }, facts)).id))?.constructor).to.eq(Session);
    await container.dispose();
  });
```

The second check shows that a fake built without a container still builds a plain `Session`. Use the file's facts fixture.

In `packages/authn-http/test/v3/authn-middleware.test.ts`, find the plain-object restore case that `a3f086d0f` added. If there is none, add a test where `restore` returns `{ handle, identity, facts, data }` as a literal. Register an `@NewInstance()` subclass of `Session` on the container the middleware resolves from, and assert that `req.storage.AuthnSession` is an instance of the subclass. Follow the file's existing middleware setup; run `graphify query "AuthnMiddleware restoreSession test"` first.

- [ ] **Step 2: Run the tests and check that they fail**

Run `npx ts-mocha -p tsconfig.json test/issuer.test.ts --grep "registered as Session"` in `packages/authn-session`, and the matching `--grep` in `packages/authn-testing`.
Expected: FAIL. The restored session is a plain `Session` (`expected Session to be an instance of AppSession`), and `container` is not in `MemorySessionOptions`.

- [ ] **Step 3: Implement the five sites**

`packages/authn-session/src/issuer.ts`:
- Add `Autoinject` and `Container` from `@spinajs/di` and `type IContainer`.
- Add `resolveSession` to the `@spinajs/authn/contracts` import. Drop the `Session` value import only if it becomes type-only.
- Add a field next to `Store`:

```ts
  @Autoinject(Container)
  protected Container!: IContainer;
```

- Replace `return new Session({ ... });` in `restore` with `return resolveSession(this.Container, { ... });`, with the same object literal.

`packages/authn-testing/src/fakes/sessions.ts`:
- Import `DI` and `type IContainer` from `@spinajs/di`, and `resolveSession` from `@spinajs/authn/contracts`.
- Add `readonly container?: IContainer;` to `MemorySessionOptions`.
- Store `this.container = opts.container ?? DI.RootContainer;` in a `private readonly container: IContainer;` field.
- `restore` returns `resolveSession(this.container, { handle: { id: rawId, state: row.state }, identity: row.subject, facts: row.facts, data: row.data })`.

`packages/authn-http/src/middleware/authn.ts:165`:
- The line becomes `return restored ? resolveSession(this.Container, restored) : restored;`.
- Keep the comment about plain objects, and add `resolveSession` to the contracts import.
- Drop the value import of `Session` if it is now unused.

`packages/authn-http/src/socket/session-source.ts:66`:
- The line becomes `const session = resolveSession(this.Container, restored);`, keeping the null guard that precedes it.
- Adjust the imports the same way as in the middleware.

`packages/authn/src/impersonation/impersonation-service.ts`, private `restore`:
- Replace `stored instanceof Session ? stored : new Session(stored)` with `resolveSession(<container>, stored)`.
- `<container>` is `this.container` at HEAD.
- If the other session's migration to `@Autoinject` fields has landed, the constructor parameter is gone. In that case add `@Autoinject(Container) protected Container!: IContainer;` and use `this.Container`. Run `git status --porcelain -- <file>` first. If the file is dirty with their work, commit only your hunk: build the index blob from HEAD plus your change, as in the earlier final-review fix.

- [ ] **Step 4: Build and run**

Rebuild, in dependency order:

```bash
cd packages/authn && npm run compile && npm run compile:cjs
cd ../authn-session && npm test
cd ../authn-testing && npm test
cd ../authn-http && npm test
cd ../authn && npm test
```

Expected: all pass, including the three new tests. A v3-app ECONNRESET or a port conflict is a known environmental flake; report it with evidence. If the full authn compile is broken by the other session's files, rerun with `TS_NODE_TRANSPILE_ONLY=true` and say so.

- [ ] **Step 5: Commit**

```bash
git add packages/authn-session/src/issuer.ts packages/authn-session/test/issuer.test.ts packages/authn-testing/src/fakes/sessions.ts packages/authn-testing/test/fakes/sessions.test.ts packages/authn-http/src/middleware/authn.ts packages/authn-http/src/socket/session-source.ts packages/authn-http/test/v3/authn-middleware.test.ts
git commit -m "feat(authn): issuers and entry points build the session class registered in DI"
```

Commit `impersonation-service.ts` separately, with only your hunk:

```bash
git commit -m "refactor(authn): impersonation service builds sessions through resolveSession"
```

---

### Task 3: Docs, RFC, snapshot

**Files:**
- Modify: `packages/authn-session/README.md`
- Create: `docs/plans/authz-v3-rfc/SO-2.md`
- Modify (generated, filtered): `packages/authn/etc/authn.api.md`, `packages/authn-testing/etc/*.api.md` if it is snapshotted

- [ ] **Step 1: README section**

Append to `packages/authn-session/README.md`:

````markdown
## Your own session class

`restore` builds the class registered as `Session` (from `@spinajs/authn/contracts`) in the container, `Session`
itself by default. Register a subclass to add typed reads of your own data keys:

```ts
import { NewInstance, DI } from '@spinajs/di';
import { Session, sessionKey } from '@spinajs/authn/contracts';

const Cart = sessionKey('Cart', (raw) => (Array.isArray(raw) ? raw.filter((i): i is string => typeof i === 'string') : []));

@NewInstance()
export class AppSession extends Session {
  public get cart(): string[] {
    return this.get(Cart) ?? [];
  }
}

DI.register(AppSession).as(Session);
// in a route: (req.storage.AuthnSession as AppSession | null)?.cart
```

- The constructor takes the `SessionInit` and passes it to `super`. Use no constructor `@Inject`, because it would come before the init.
- Keep `@NewInstance()`, and re-declare it whenever the class carries another DI decorator. A shared instance is refused.
- Do not depend on an `AsyncService`, because sessions are built synchronously.
- Write data with `SessionIssuer.set(handle, Cart.name, value)`.
````

- [ ] **Step 2: RFC**

Create `docs/plans/authz-v3-rfc/SO-2.md` in the style of `SO-1.md`:

```markdown
# RFC SO-2: the session class resolves through DI

Status: APPLIED on feat/authz-v3 (plan docs/superpowers/plans/2026-10-16-session-di.md).

## Problem

SO-1 made `restore` return a `Session`, built with `new Session(...)` in each issuer and entry point. An app could
not add typed reads of its own data keys without wrapping every session it reads.

## Change

- `Session` is `@NewInstance()`; the contracts still register nothing at load.
- New `resolveSession(container, value)`: `value` when it is a `Session`, else the class registered as `Session` in
  `container` (`Session` itself when none is), built with `value`. It throws when that class resolves to a non-Session
  (an AsyncService dependency) or hands back a shared instance (no `@NewInstance()`).
- `DefaultSessionIssuer`, `MemorySessionIssuer` (new option `container`, default the root container), the authn
  middleware, the socket session source and the impersonation service build sessions through it.

## Affected lanes

- Apps: `container.register(AppSession).as(Session)`; subclass rules in `packages/authn-session/README.md`.
- Third-party `SessionIssuer` implementations should build through `resolveSession` so a registered class applies.
```

- [ ] **Step 3: Snapshot, filtered**

Run, from the repo root: `node scripts/api-snapshot.mjs --update`.
- Then check `git diff -- packages/*/etc/*.api.md`. Keep only the hunks for `resolveSession`, the `MemorySessionOptions.container` field, and any doc-comment change in this plan's files.
- Revert every other hunk. Those belong to other sessions' uncommitted work. Use the filtered `git apply --cached` method if a file mixes both.
- Restore any `*.api.md` that changed only in line endings: `git checkout -- <file>`.

- [ ] **Step 4: Commit and graph**

```bash
git add packages/authn-session/README.md docs/plans/authz-v3-rfc/SO-2.md packages/authn/etc/authn.api.md
git commit -m "docs(authn): session class through DI, RFC SO-2, API snapshot"
graphify update .
```

Also add any `packages/authn-testing/etc/*.api.md` that holds a kept hunk.

---

## Out of scope

- A generic `AuthnSession` request-storage type, such as `req.storage.AuthnSession as T` through module augmentation. Consumers cast or use `instanceof`.
- Typed writes (`set(h, key, value)` with an encoder). This is the existing SO-1 follow-up.
