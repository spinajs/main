# Configuration Phase 2: authn core through `@Config` and the schema

**Goal:** The classes of `packages/authn/src` stop reading `Configuration` by hand and stop validating by hand. Each takes its keys from `@Config`, and every value rule and default lives in `AUTHN_CONFIGURATION_SCHEMA` (`packages/authn/src/schemas/authn.configuration.ts`). A bad value now fails the boot with `InvalidConfiguration`, and `violations[].path` is the full configuration path of the bad value.

**Scope:** the seven rows of `.superpowers/sdd/phase-2-inventory.md`, plus one prerequisite task (the test harness does not register the schema today). The audit class (`authn.audit`, Task 5) is the pilot and is not planned here.

**References (read before starting a task):**
- `.superpowers/sdd/global-constraints.md`: English comments and messages, one commit per task, commands run from the package dir, rebuild a changed package before its dependants read `lib/`, CRLF in working-copy files, value checks go to the schema, code keeps only DI lookups, compiling and cross-domain merges, defaults go to the schema.
- `.superpowers/sdd/mechanism-notes.md`: how `@Config` and validation work now. It overrides older plan text.
- `.superpowers/sdd/recipe.md` and `.superpowers/sdd/task-5-brief.md`: the per-class recipe and the shape of a task.

**Facts verified against the current code (2026-10-05):**
- Every inventory line number is still right (`fresh-auth-check.ts:57`, `impersonation-service.ts:138`, `default-mfa-policy.ts:32`, `default-authn-service.ts:179`, `memory-throttle.ts:68`).
- The Task 5 pilot has NOT landed: `packages/authn/src/audit/*` still uses `readAuditConfig`. These tasks do not touch `audit/`, `authn-audit.ts` or `log-sink.ts`.
- The hidden-key constant exported by `packages/configuration/src/decorators.ts` is `CONFIGURATION_CONTAINER_KEY` in the working copy (the Task 5 brief still says `CONFIGURATION_INJECTION_KEY`). Use whichever name the file exports when the task runs.
- DI assigns `@Config`'s hidden container key AFTER the constructor runs (`packages/di/src/container.ts:631`). A constructor cannot read an `@Config` property. `SyncService.resolve()` and `AsyncService.resolve()` run after the assignment, so boot-time DI checks go there (Task 2.5).
- `@Config` getters read on every access. A class that needs fixed values for its lifetime (the memory throttle's tables) snapshots them on first use.
- `buildCore` in `packages/authn/test/behaviour/harness.ts` registers a child `Configuration` but NOT `AUTHN_CONFIGURATION_SCHEMA`. Until Task 2.1, a test through `buildCore` is not schema-validated and gets no schema defaults.
- Violation paths join with dots and array indexes are plain segments: `authn.strategies.0.service`, `authn.throttle.login.account.free`.
- The Ajv options of the app (`packages/configuration/src/configuration.ts` `initValidator`) are `coerceTypes: true`, `useDefaults: true`, `removeAdditional: true`, `allErrors: true`, `$data: true`. `coerceTypes` makes some bad values valid (the string `'300'` becomes the number 300, `1` becomes `true`). Each task drops the old "string is refused" cases and says so.

## Task order and parallelism

```
2.1 harness (first, alone)
  then in parallel: 2.2   2.3   2.4   2.7
  then:             2.5 (after 2.4)
  then:             2.6 (after 2.5 and 2.7)
  then:             2.8 (after 2.4 and 2.5)
```

Why this order:
- 2.2, 2.3, 2.4 and 2.7 touch disjoint `src` files, disjoint test files, and disjoint hunks of `authn.configuration.ts` (table below). The only shared file is `test/boot/config-defaults.test.ts` (2.2 and 2.7 edit different `it` blocks), so the merge is trivial.
- 2.5 edits the `mfa` block that sits next to the `steps` line 2.4 touches, and both edit `test/flow/mfa.test.ts`.
- 2.6 edits `default-authn-service.test.ts`, which 2.7 also edits (its `RecordingThrottle` construction), and it needs the `mfa.policy.service` default that 2.5 adds.
- 2.8 deletes `readNamedEntries`, whose last callers are the registries (2.4), `DefaultMfaPolicy` (2.5) and `check-config.ts` (2.8 itself).
- Dependant-package runs (Step 5) go one task at a time, never in parallel: every dependant reads authn from `lib/`, which each task rebuilds.

Schema hunks per task (all in `packages/authn/src/schemas/authn.configuration.ts`, line numbers of today):

| Task | Hunk | Edit |
|---|---|---|
| 2.2 | `freshAuth` block (about lines 242-247) | add `default: {}`; `maxAgeSeconds` gets `default: 300` |
| 2.3 | `impersonation` block (about lines 285-292) | add `default: {}` only (its fields already have defaults) |
| 2.4 | the `named` constant (lines 46-57) | add `default: []` |
| 2.5 | `mfa` block, `properties.policy` and a new `allOf` (about lines 168-190) | `mfa` and `policy` get `default: {}`; `service`, `force`, `forceForRoles` get defaults; two `if/then` rules |
| 2.6 | `linking` block (about lines 278-284) | add `default: {}`; both flags get `default: false` |
| 2.7 | `throttle.properties.maxRows` (line 238) | add `default: 1000000`, adjust the description |
| 2.8 | `config` block (lines 82-88) and `local.pepper` extras (lines 109-124) | `config` gets `default: {}` and `rejectLegacyKeys` `default: false`; `pepper.version` gets `maximum` and `default: 1`; `previous` items get a `$data` rule |

Rows `@Config` cannot serve, and the chosen alternative:
- Boot checks (`authnSecretFindings`, `checkAuthnLegacyKeys`, `rejectsAuthnLegacyKeys`, `authnEnvFellBack`, `checkAuthnConfig`): plain functions, no class. They keep taking a `Configuration`; `DefaultAuthnService.resolve()` hands them the container's one. Only the type and shape checks are deleted (Task 2.8).
- `readNamedEntries`: a plain function. It is deleted; `StrategyRegistry` and `MfaStepRegistry` read the list through `@Config` (Task 2.4), and `check-config.ts` reads it with a typed `config.get` (Task 2.8).
- `DefaultMfaPolicy`: its checks ran in the constructor, which cannot read `@Config`. They move to `resolve()`, so `MfaPolicy` becomes a `SyncService` (Task 2.5).
- `MemoryAuthnThrottle`: built with `new` and explicit params by many tests, and a root singleton in production. The explicit-params seam stays; an instance built with `new` and no params reads the root Configuration, or the container pinned with `pinConfiguration` (Task 2.7).
- `isFresh`: a pure function that validates its own argument, not a configuration read. It stays.

---

### Task 2.1: The test harness applies the authn schema

**Files:**
- Modify: `packages/authn/test/behaviour/harness.ts`: imports (lines 1-10), a new block of helpers after `configurationOf` (after line 115), and `prepareCore` (the `child.register(configurationOf(...))` line, 182 today)
- Create: `packages/authn/test/behaviour/schema-harness.test.ts`
- Test: whole `packages/authn` suite (fix any test value the schema now refuses; do not loosen the schema)

**Interfaces:**
- Consumes: `registerConfigurationSchema` semantics and the `'__configurationSchema__'` registration key (`packages/configuration/src/schemas.ts`), `CONFIGURATION_CONTAINER_KEY` and `InvalidConfiguration` from `@spinajs/configuration`.
- Produces, all exported from `harness.ts`:
  - `useAuthnSchema(child: IContainer): void`
  - `configuredChild(values: Record<string, unknown>, env?: string, isolated?: boolean): Promise<IContainer>` (a child of `DI.RootContainer` with the schema and a Configuration registered and resolved; disposes itself and rethrows when the Configuration fails to resolve)
  - `pinConfiguration<T extends object>(instance: T, container: IContainer): T`
  - `invalidOf(boot: Promise<unknown>): Promise<InvalidConfiguration>`
  - `violationPaths(boot: Promise<unknown>): Promise<string[]>`

`registerConfigurationSchema(schema, child)` is not used on purpose: when the child has no Configuration of its own yet it validates against the nearest ancestor's one (the root), which can throw on unrelated values. The schema is registered directly, as the Task 5 brief does.

- [ ] **Step 1: Schema additions**

None. This task only wires the existing schema into the harness.

- [ ] **Step 2: Write the failing tests**

Create `packages/authn/test/behaviour/schema-harness.test.ts`:

```ts
import assert from 'node:assert/strict';
import 'mocha';
import { Config, Configuration } from '@spinajs/configuration';

import { buildCore, configuredChild, invalidOf, pinConfiguration, useHarnessLog, violationPaths } from './harness.js';

class Probe {
  @Config('authn.audit.sampleUse')
  public Sample: number;
}

describe('harness: the authn schema applies to every boot', function () {
  this.timeout(30000);

  useHarnessLog();

  it('buildCore fails with InvalidConfiguration, naming the path, on a value the schema refuses', async () => {
    const paths = await violationPaths(buildCore({}, { raw: { authn: { freshAuth: { maxAgeSeconds: 0 } } } }));
    assert.ok(paths.includes('authn.freshAuth.maxAgeSeconds'), paths.join(', '));
  });

  it('configuredChild resolves a Configuration with the schema defaults applied', async () => {
    const child = await configuredChild({ authn: { throttle: {} } });
    try {
      assert.strictEqual(child.get(Configuration)!.get('authn.throttle.resetAfterSeconds'), 86400);
    } finally {
      await child.dispose();
    }
  });

  it('configuredChild fails with InvalidConfiguration and leaves no child behind', async () => {
    const error = await invalidOf(configuredChild({ authn: { throttle: { resetAfterSeconds: 0 } } }));
    assert.ok(error.violations.some((v) => v.path === 'authn.throttle.resetAfterSeconds'));
  });

  it('pinConfiguration points an instance built with new at the Configuration of the child', async () => {
    const child = await configuredChild({ authn: { audit: { sampleUse: 0.5 } } });
    try {
      assert.strictEqual(pinConfiguration(new Probe(), child).Sample, 0.5);
    } finally {
      await child.dispose();
    }
  });

  it('violationPaths rethrows what is not an InvalidConfiguration', async () => {
    await assert.rejects(violationPaths(Promise.reject(new RangeError('boom'))), RangeError);
  });
});
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/behaviour/schema-harness.test.ts`
Expected: FAIL at compile time: `Module '"./harness.js"' has no exported member 'configuredChild'` (and the same for `invalidOf`, `pinConfiguration`, `violationPaths`).

- [ ] **Step 4: Implement**

In `harness.ts`, extend the imports:

```ts
import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
```

and add `AUTHN_CONFIGURATION_SCHEMA` to the existing `'../../src/index.js'` import list. After `configurationOf` add:

```ts
/** Registers the authn schema in `child`, as the AuthnConfigBootstrapper does for the app. */
export function useAuthnSchema(child: IContainer): void {
  child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
}

/** A child of the root with the authn schema and a Configuration of `values`, resolved: schema defaults applied, bad values refused. */
export async function configuredChild(values: Record<string, unknown>, env?: string, isolated = false): Promise<IContainer> {
  const child = DI.RootContainer.child();
  try {
    useAuthnSchema(child);
    child.register(configurationOf(values, env, isolated)).as(Configuration);
    await child.resolve(Configuration);
    return child;
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

/** An instance built with `new` has no injected container: point its `@Config` properties at `container`. */
export function pinConfiguration<T extends object>(instance: T, container: IContainer): T {
  (instance as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = container;
  return instance;
}

export async function invalidOf(boot: Promise<unknown>): Promise<InvalidConfiguration> {
  try {
    await boot;
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e;
    throw e;
  }
  throw new Error('expected the boot to fail with InvalidConfiguration');
}

export async function violationPaths(boot: Promise<unknown>): Promise<string[]> {
  return (await invalidOf(boot)).violations.map((v) => v.path);
}
```

In `prepareCore`, register the schema before the Configuration:

```ts
  const child = DI.RootContainer.child();
  try {
    useAuthnSchema(child);
    child.register(configurationOf(values, opts.unsetEnv ? undefined : (config.env ?? 'test'))).as(Configuration);
```

Functions deleted: none.

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/behaviour/schema-harness.test.ts` (expect 5 passing).
2. `npm test` in `packages/authn`. Any test whose `raw` or `config` values the schema now refuses fails with `InvalidConfiguration`. Fix the TEST value (the schema is the contract); list each fix in the commit body. Pay attention to `test/mutation/core-mutants.test.ts`, `test/service/default-authn-service.test.ts` and `test/boot/*`.
3. No `src` change, so no rebuild and no dependants run.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/test/behaviour/harness.ts packages/authn/test/behaviour/schema-harness.test.ts
git commit -m "test(authn): the harness validates every boot against the authn schema"
```
Add any test file fixed in step 5 to the same `git add`.

---

### Task 2.2: `FreshAuthCheck` takes `authn.freshAuth.maxAgeSeconds` from `@Config`

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:242-247` (`freshAuth` block)
- Modify: `packages/authn/src/freshauth/fresh-auth-check.ts:1-77` (imports; delete `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS` at 12-13 and `readMaxAge` at 30-34; class body 41-77)
- Test: `packages/authn/test/freshauth/fresh-auth.test.ts` (the `FreshAuthCheck` describe, lines 49-80), `packages/authn/test/boot/config-defaults.test.ts` (line 8 import and line 51 `freshAuth` assertion)

**Interfaces:**
- Consumes: `@Config` (`@spinajs/configuration`), `useAuthnSchema`/`violationPaths` from Task 2.1.
- Produces: `FreshAuthCheck.maxAgeSeconds: number` (getter, unchanged signature, now live). `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS` is removed from the barrel. `authn-totp` keeps its own copy and is out of scope.

- [ ] **Step 1: Schema additions**

Replace the `freshAuth` block with:

```ts
    freshAuth: {
      type: 'object',
      default: {},
      properties: {
        maxAgeSeconds: { type: 'integer', minimum: 1, default: 300, description: 'A session authenticated this many seconds ago or less counts as fresh (A13).' },
      },
    },
```

- [ ] **Step 2: Write the failing tests**

In `fresh-auth.test.ts` replace the two tests `reads authn.freshAuth.maxAgeSeconds, 300 when unset` and `fails to resolve with a maxAgeSeconds that is not a positive integer` (lines 70-85) with the following, and add `violationPaths` to the harness import; drop `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS` from the `../../src/index.js` import:

```ts
    it('gets 300 from the schema default when authn.freshAuth is unset', async () => {
      const { p, fresh } = await boot();
      assert.strictEqual(p.configuration.get('authn.freshAuth.maxAgeSeconds'), 300);
      assert.strictEqual(fresh.maxAgeSeconds, 300);
    });

    it('reads the configured authn.freshAuth.maxAgeSeconds', async () => {
      assert.strictEqual((await boot({ maxAgeSeconds: 60 })).fresh.maxAgeSeconds, 60);
    });

    it('follows the Configuration after boot rather than a snapshot', async () => {
      const { p, fresh, a } = await boot({ maxAgeSeconds: 60 });
      p.configuration.set('authn.freshAuth.maxAgeSeconds', 90);
      assert.strictEqual(fresh.maxAgeSeconds, 90);
      const s = await issue(p, a);
      assert.strictEqual(await fresh.check(s, ctx(at(90 * SECOND), s)), true);
      assert.strictEqual(await fresh.check(s, ctx(at(90 * SECOND + 1), s)), false);
    });

    it('refuses a maxAgeSeconds that is not a positive integer, naming its path', async () => {
      for (const bad of [0, -5, 1.5, 'abc']) {
        const paths = await violationPaths(boot({ maxAgeSeconds: bad }));
        assert.ok(paths.includes('authn.freshAuth.maxAgeSeconds'), `${String(bad)}: ${paths.join(', ')}`);
      }
    });
```
(`'300'` is no longer a bad value: `coerceTypes` turns it into 300.)

In `config-defaults.test.ts` line 8 drop `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS` from the import, and replace line 51 with:

```ts
    expect(authn.freshAuth).to.deep.eq(check({}).config.freshAuth);
    expect(check({}).config.freshAuth).to.deep.eq({ maxAgeSeconds: 300 });
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/freshauth/fresh-auth.test.ts test/boot/config-defaults.test.ts`
Expected: FAIL. `gets 300 from the schema default` fails (`p.configuration.get('authn.freshAuth.maxAgeSeconds')` is `undefined`: the schema has no default yet), `follows the Configuration after boot` fails (`fresh.maxAgeSeconds` is still 60: the value is snapshotted at `resolve()`), and the config-defaults `freshAuth` assertion fails (`check({}).config.freshAuth` is undefined).

- [ ] **Step 4: Implement**

`fresh-auth-check.ts`, whole top and class (the `isFresh` function at lines 15-28 stays as is):

```ts
import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

import type { AuthnContext, Credentials } from '../contracts/credentials.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { AuthnService } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';

/**
 * True when `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary included. A time after `now` or
 * an invalid one is not fresh, nor is an impersonation: the impersonator must not act on the target's credentials (M6).
 */
export function isFresh(facts: Pick<AuthnFacts, 'authenticatedAt' | 'impersonator'>, now: Date, maxAgeSeconds: number): boolean {
  if (typeof maxAgeSeconds !== 'number' || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new InvalidArgument('isFresh: maxAgeSeconds must be a positive number');
  }
  if (facts?.impersonator !== undefined) return false;
  const at = facts?.authenticatedAt;
  if (!(at instanceof Date) || !(now instanceof Date)) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

/**
 * Fresh authentication for sensitive actions (A13): the active session authenticated within
 * `authn.freshAuth.maxAgeSeconds`, or an inline re-authentication of its identity, which counts for this request only.
 * One per container. Not named FreshAuth: DI keys classes by name, and authn-http's route policy has that name.
 */
@PerChildInstance()
@Inject(Container)
export class FreshAuthCheck extends AsyncService {
  @Config('authn.freshAuth.maxAgeSeconds')
  protected MaxAgeSeconds: number;

  private authn!: AuthnService;
  private sessions!: SessionIssuer;

  constructor(private readonly container: IContainer) {
    super();
  }

  public get maxAgeSeconds(): number {
    return this.MaxAgeSeconds;
  }

  public async resolve(): Promise<void> {
    if (!this.container.hasRegistered(SessionIssuer as unknown as Class<SessionIssuer>)) throw new InvalidOperation('FreshAuthCheck: no SessionIssuer is registered');
    this.sessions = (await this.container.resolve(SessionIssuer as unknown as Class<SessionIssuer>)) as SessionIssuer;
    this.authn = (await this.container.resolve(AuthnService as unknown as Class<AuthnService>)) as AuthnService;
    await super.resolve();
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async check(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    const id: unknown = (session as Partial<SessionHandle> | null | undefined)?.id;
    if (typeof id !== 'string' || id === '') return false;
    const stored = await this.sessions.restore(id);
    if (!stored || stored.handle.state !== 'active' || stored.facts.impersonator !== undefined) return false;
    if (isFresh(stored.facts, ctx.now, this.MaxAgeSeconds)) return true;
    return reauth !== undefined && (await this.authn.reauthenticate(session, reauth, ctx));
  }
}
```

Deleted: the `Configuration` and `InvalidOption` imports, `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS`, `readMaxAge`, the `Configuration` resolve and its `get()` guard, the private `maxAge` field. Kept in code (not expressible in a schema): the `SessionIssuer` DI lookup. Nothing else in the repo imports `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS` from authn (`authn-totp` declares its own).

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/freshauth/fresh-auth.test.ts test/boot/config-defaults.test.ts`
2. `npm test` in `packages/authn`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in `packages/authn`.
4. Dependants, one after another: `cd ../authn-http && npm test`, then `cd ../authn-totp && npm test` (it has its own `FreshAuth` copy; this checks it still resolves against the rebuilt authn).

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/freshauth/fresh-auth-check.ts packages/authn/test/freshauth/fresh-auth.test.ts packages/authn/test/boot/config-defaults.test.ts
git commit -m "refactor(authn): authn.freshAuth through @Config and the schema, no hand validation"
```

---

### Task 2.3: `AuthnImpersonationService` takes `authn.impersonation` and the session lifetime from `@Config`

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:285-292` (`impersonation` block)
- Modify: `packages/authn/src/impersonation/impersonation-service.ts`: imports (1-17), `Settings` interface (24-29), `readSettings` (74-94), field `settings` (131), `resolve()` (137-150), uses at lines 261, 264, 282, 308
- Test: `packages/authn/test/impersonation/impersonation-service.test.ts` (`boot` describe, lines 618-637; one new test in the `principalOf` area near line 472)

**Interfaces:**
- Consumes: `@Config`, Task 2.1 helpers.
- Produces: `AuthnImpersonationService` public API unchanged. New protected members `Settings: ImpersonationConfig` and `MaxLifetimeMinutes: number`; exported type `ImpersonationConfig { readonly requirePassword: boolean; readonly requireMfa: boolean; readonly maxMinutes: number }`.

Decision on `authn.session.expiration.maxLifetime`: it belongs to the `session` subtree that `@spinajs/authn-session` ships (`authn-session/src/config/session.ts` sets 480) and reads with `@Config(..., { defaultValue: 480 })`. Authn core cannot import authn-session, and a schema default on `session` would create the whole `session.expiration` object for apps that never import authn-session. So the service uses `@Config('authn.session.expiration.maxLifetime', { defaultValue: 480 })`, the same call as authn-session. The schema already requires an integer of at least 1; the code accepted any positive number (a fraction of a minute). The schema wins: fractions are refused now.

- [ ] **Step 1: Schema additions**

In the `impersonation` block add `default: {}` as the second key (the three fields keep their existing defaults, which then materialise when `authn.impersonation` is unset):

```ts
    impersonation: {
      type: 'object',
      default: {},
      properties: {
        requirePassword: { type: 'boolean', default: true },
        requireMfa: { type: 'boolean', default: true },
        maxMinutes: { type: 'integer', minimum: 1, default: 60 },
      },
    },
```

- [ ] **Step 2: Write the failing tests**

Replace the test `reads authn.impersonation and fails on malformed values` (lines 619-635) with these three, add `violationPaths` to the harness import:

```ts
    it('takes the impersonation defaults from the schema when authn.impersonation is unset', async () => {
      const { p } = await boot();
      assert.deepStrictEqual(p.configuration.get('authn.impersonation'), { requirePassword: true, requireMfa: true, maxMinutes: 60 });
    });

    it('refuses malformed settings, naming the path of each', async () => {
      const cases: [unknown, string][] = [
        [{ maxMinutes: 0 }, 'authn.impersonation.maxMinutes'],
        [{ maxMinutes: 1.5 }, 'authn.impersonation.maxMinutes'],
        [{ requireMfa: 'yes' }, 'authn.impersonation.requireMfa'],
        ['on', 'authn.impersonation'],
      ];
      for (const [bad, path] of cases) {
        const paths = await violationPaths(boot(bad as Record<string, unknown>));
        assert.ok(paths.includes(path), `${JSON.stringify(bad)}: ${paths.join(', ')}`);
      }
      for (const bad of [0, -5, 1.5, 'abc']) {
        const paths = await violationPaths(boot(undefined, {}, { session: { expiration: { maxLifetime: bad } } }));
        assert.ok(paths.includes('authn.session.expiration.maxLifetime'), `${String(bad)}: ${paths.join(', ')}`);
      }
    });

    it('reads maxMinutes when it uses it, not at boot', async () => {
      const booted = await boot({ maxMinutes: 60 });
      const { p, svc } = booted;
      const { imp } = await started(booted);
      p.configuration.set('authn.impersonation.maxMinutes', 10);
      assert.strictEqual(await svc.principalOf(imp, ctx(at(10 * MINUTE))), null);
      assert.strictEqual(events(p, 'impersonation.expire').length, 1);
    });
```
(`'60'` and `1` are dropped from the bad list: `coerceTypes` accepts them.) The test `ends the impersonation once the original login is maxLifetime old, 480 min by default (I1)` (line 565) already covers the code default of 480; it must still pass unchanged.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/impersonation/impersonation-service.test.ts`
Expected: FAIL. `takes the impersonation defaults from the schema` fails (`authn.impersonation` is undefined, no `default: {}` before this task), and `reads maxMinutes when it uses it` fails (`principalOf` still returns the principal: the limit is the 60 read at boot).

- [ ] **Step 4: Implement**

`impersonation-service.ts` imports:

```ts
import { createHash } from 'node:crypto';
import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
```
(`Configuration` and `InvalidOption` are no longer used in this file.)

Replace the `Settings` interface (24-29) with:

```ts
export interface ImpersonationConfig {
  readonly requirePassword: boolean;
  readonly requireMfa: boolean;
  readonly maxMinutes: number;
}
```

Keep `DEFAULT_MAX_LIFETIME_MINUTES = 480` and its doc comment; delete `readSettings` (74-94). In the class replace the `settings` field and `resolve()`:

```ts
  @Config('authn.impersonation')
  protected Settings: ImpersonationConfig;

  // authn-session ships and reads the same default for the same key; authn core cannot import it.
  @Config('authn.session.expiration.maxLifetime', { defaultValue: DEFAULT_MAX_LIFETIME_MINUTES })
  protected MaxLifetimeMinutes: number;

  private sessions!: SessionIssuer;
  private identities!: IdentityStore;
  private principals!: PrincipalFactory;
  private guard: ImpersonationGuard | undefined;
  private fresh!: FreshAuthCheck;
  private auditor!: AuthnAudit;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    this.sessions = (await this.neighbour(SessionIssuer, 'SessionIssuer', true))!;
    this.identities = (await this.neighbour(IdentityStore, 'IdentityStore', true))!;
    this.principals = (await this.neighbour(PrincipalFactory, 'PrincipalFactory', true))!;
    this.guard = await this.neighbour(ImpersonationGuard, 'ImpersonationGuard', false);
    this.fresh = await this.container.resolve(FreshAuthCheck);
    this.auditor = await this.container.resolve(AuthnAudit);
    await super.resolve();
  }
```

Four uses change:
- line 261: `this.settings.requireMfa` becomes `this.Settings.requireMfa`
- line 264: `this.settings.requirePassword` becomes `this.Settings.requirePassword`
- line 282: `this.settings.maxMinutes` becomes `this.Settings.maxMinutes`
- line 308: `this.settings.maxLifetimeMinutes` becomes `this.MaxLifetimeMinutes`

Kept in code: the neighbour DI lookups (`neighbour(...)`, `InvalidOperation` for a missing required service).

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/impersonation/impersonation-service.test.ts test/boot/config-defaults.test.ts`
2. `npm test` in `packages/authn`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `cd ../authn-http && npm test` (impersonation controller and harness), `cd ../users && npm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/impersonation/impersonation-service.ts packages/authn/test/impersonation/impersonation-service.test.ts
git commit -m "refactor(authn): authn.impersonation through @Config and the schema, no hand validation"
```

---

### Task 2.4: `StrategyRegistry` and `MfaStepRegistry` take their lists from `@Config`

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:46-57` (the `named` constant)
- Modify: `packages/authn/src/registry/strategy-registry.ts:1-86` (imports; `resolve()` at 68-86)
- Modify: `packages/authn/src/flow/mfa-step-registry.ts:1-56` (imports; `resolve()` at 41-56)
- Test: `packages/authn/test/registry/strategy-registry.test.ts` (boot describe, lines 186-260), `packages/authn/test/flow/mfa.test.ts` (`MfaStepRegistry` describe, lines 67-119)
- NOT touched here: `packages/authn/src/registry/named.ts`. `readNamedEntries` still has callers in `default-mfa-policy.ts` (Task 2.5) and `check-config.ts` (Task 2.8) and is deleted in Task 2.8.

**Interfaces:**
- Consumes: `@Config`, `NamedEntry` from `registry/named.ts`, Task 2.1 helpers.
- Produces: `StrategyRegistry` and `MfaStepRegistry` public API unchanged; new protected `Entries: NamedEntry[]` on each. `RECOVERY_STEP` stays exported (`default-authn-service.ts:473` uses it).

Conflict named by the inventory: the schema rejects a repeated name (`uniqueItemProperties: ['name']`, also an identical entry), while `readNamedEntries` dropped exact duplicates (config files concatenate arrays, so a file that repeats the package default lists an entry twice). Resolution: keep the schema rule. Packages ship no entry (`src/config/authn.ts` ships `strategies: []`), so a repeat can only come from an app's own files and is an error it should fix. The reserved name `recovery` is already a schema rule (`not: { enum: ['recovery'] }` on the step name), so the code check goes.

- [ ] **Step 1: Schema additions**

In the `named` constant add `default: []` so an absent list is the empty list for both `strategies` and `steps` (both spread `named`):

```ts
const named = {
  type: 'array',
  default: [],
  uniqueItemProperties: ['name'],
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      service: { type: 'string', minLength: 1 },
    },
    required: ['name', 'service'],
  },
};
```

- [ ] **Step 2: Write the failing tests**

`strategy-registry.test.ts`: the root-based scaffolding (`before`, `afterEach`, `cfg`, `boot`, `bootFails`) stays for the DI-lookup tests. Delete these tests from the `boot` describe, which the schema now owns: `fails on the same name listed with two services`, `collapses identical entries that config files repeat`, `fails on malformed entries`, `does not echo config values of malformed entries`. In `boots with no strategies when authn.strategies is missing or empty` delete the first line (`expect(names(await boot(undefined)))...`; the `[]` case stays). Add the imports `import type { IContainer } from '@spinajs/di';` and `import { configuredChild, invalidOf, violationPaths } from '../behaviour/harness.js';`, then add this describe inside `describe('StrategyRegistry', ...)`, after `describe('boot', ...)`:

```ts
  describe('configuration shape', () => {
    const kids: IContainer[] = [];

    afterEach(async () => {
      for (const c of kids.splice(0)) await c.dispose();
    });

    async function bootChild(authn: unknown): Promise<StrategyRegistry> {
      const child = await configuredChild({ authn });
      kids.push(child);
      return child.resolve(StrategyRegistry);
    }

    it('lists no strategy when authn.strategies is unset, through the schema default', async () => {
      expect(names(await bootChild({}))).to.deep.equal([]);
    });

    const refused: [string, unknown, string][] = [
      ['a string instead of a list', 'LocalPassword', 'authn.strategies'],
      ['an entry without a service', [{ name: 'local' }], 'authn.strategies.0.service'],
      ['an entry with an empty name', [{ name: '', service: 'LocalPassword' }], 'authn.strategies.0.name'],
      ['a null entry', [null], 'authn.strategies.0'],
      ['the same name with two services', [LOCAL, entry('local', 'PlainBearer')], 'authn.strategies'],
      // Config files concatenate arrays; the schema keeps one entry per name, identical repeats included.
      ['an identical entry listed twice', [LOCAL, { ...LOCAL }], 'authn.strategies'],
    ];
    for (const [what, strategies, path] of refused) {
      it(`refuses ${what}, naming ${path}`, async () => {
        expect(await violationPaths(configuredChild({ authn: { strategies } }))).to.include(path);
      });
    }

    it('does not echo config values of a malformed entry', async () => {
      const error = await invalidOf(configuredChild({ authn: { strategies: [LOCAL, { name: 'oops', options: { secret: 'hunter2-secret' } }] } }));
      expect(error.message).to.not.contain('hunter2');
      expect(error.violations.map((v) => v.path)).to.include('authn.strategies.1.service');
    });
  });
```

`flow/mfa.test.ts`: add `configuredChild`-free path assertions through `buildCore`. Add `violationPaths` to the harness import. Replace the tests `is empty when authn.mfa.steps is unset or null`, `keeps one entry when the list repeats it` and `fails boot on an unknown service, ...` (lines 80-119) with:

```ts
    it('is empty when authn.mfa.steps is unset, through the schema default', async () => {
      await boot({ steps: undefined });
      assert.deepStrictEqual((await parts!.child.resolve(MfaStepRegistry)).steps(), []);
    });

    it('fails boot on an unknown service, a name mismatch and a non-step', async () => {
      await bootFails({ steps: [{ name: 'totp', service: 'TotpMfaStep' }] }, 'authn.mfa.steps', 'TotpMfaStep');
      await bootFails({ steps: [{ name: 'other', service: KIT_MFA_STEP }] }, 'authn.mfa.steps', '"other"', '"fake"');
      await bootFails({ steps: [{ name: 'x', service: 'NotAStep' }], register: (c) => bind(c, MfaStep, 'NotAStep', { name: 'x' }) }, 'NotAStep', 'not an MfaStep');
    });

    const refused: [string, unknown, string][] = [
      ['the reserved name recovery', [{ name: 'recovery', service: KIT_MFA_STEP }], 'authn.mfa.steps.0.name'],
      ['a name listed twice', [{ name: 'fake', service: KIT_MFA_STEP }, { name: 'fake', service: 'Step_second' }], 'authn.mfa.steps'],
      ['an identical entry listed twice', [{ name: 'fake', service: KIT_MFA_STEP }, { name: 'fake', service: KIT_MFA_STEP }], 'authn.mfa.steps'],
      ['a string instead of a list', 'totp', 'authn.mfa.steps'],
      ['null instead of a list', null, 'authn.mfa.steps'],
      ['an empty name', [{ name: '', service: KIT_MFA_STEP }], 'authn.mfa.steps.0.name'],
    ];
    for (const [what, steps, path] of refused) {
      it(`refuses ${what}, naming ${path}`, async () => {
        const paths = await violationPaths(boot({ steps, extra: [new FakeMfaStep({ name: 'second' })] }));
        assert.ok(paths.includes(path), paths.join(', '));
      });
    }
```
`bootFails` (unchanged) stays for the DI-lookup cases.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/registry/strategy-registry.test.ts test/flow/mfa.test.ts`
Expected: FAIL. Every `refuses ...` case in both files fails: with `expected the boot to fail with InvalidConfiguration` where the hand reader accepts the value (an identical repeated entry is silently dropped today), and with `got InvalidOption` where it throws (the reserved name, a duplicate name, a malformed entry). The two `unset ... through the schema default` tests pass before and after: they pin the default.

- [ ] **Step 4: Implement**

`strategy-registry.ts` imports and `resolve()`:

```ts
import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { AuthenticationStrategy } from '../contracts/strategy.js';
import type { Credentials } from '../contracts/credentials.js';
import { instantiate, kindOf, nearestRegistration, nonEmpty, q } from './named.js';
import type { NamedEntry } from './named.js';
```

```ts
@PerChildInstance()
@Inject(Container)
export class StrategyRegistry extends AsyncService {
  @Config('authn.strategies')
  protected Entries: NamedEntry[];

  private listed: readonly Listed[] | undefined;
  private all: readonly AuthenticationStrategy[] | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    const listed: Listed[] = [];
    for (const e of this.Entries) {
      // The whole lineage: a child may list a root strategy next to its own.
      const type = nearestRegistration(this.container, AuthenticationStrategy, e.service);
      if (!type) {
        throw new InvalidOption(`authn.strategies entry ${q(e.name)}: no AuthenticationStrategy is registered as service ${q(e.service)}`);
      }
      listed.push(check(e, await instantiate(this.container, type)));
    }
    this.listed = Object.freeze(listed);
    this.all = Object.freeze(listed.map((l) => l.strategy));
    await super.resolve();
  }
```
Update the class doc: drop "a duplicate name" from the boot-failure list (the schema refuses it before the registry builds). `check`, `accepts`, `strategies()`, `candidates()`, `state()` are unchanged.

`mfa-step-registry.ts`:

```ts
import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { MfaStep } from '../contracts/mfa.js';
import { instantiate, kindOf, nearestRegistration, q } from '../registry/named.js';
import type { NamedEntry } from '../registry/named.js';
```

```ts
export class MfaStepRegistry extends AsyncService {
  @Config('authn.mfa.steps')
  protected Entries: NamedEntry[];

  private listed: readonly MfaStep[] | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    const listed: MfaStep[] = [];
    for (const e of this.Entries) {
      const type = nearestRegistration(this.container, MfaStep, e.service);
      if (!type) throw new InvalidOption(`authn.mfa.steps entry ${q(e.name)}: no MfaStep is registered as service ${q(e.service)}`);
      listed.push(check(e, await instantiate(this.container, type)));
    }
    this.listed = Object.freeze(listed);
    await super.resolve();
  }
```
Update the class doc: the reserved name `recovery` and a duplicate name are refused by the schema. `RECOVERY_STEP` and its comment stay (`completeMfa` uses it). Kept in code: the service lookup by name among the registrations of the lineage, the duck-typing of what the service returned, the name-equals-service-name check (DI and instance checks, not value checks).

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/registry/strategy-registry.test.ts test/flow/mfa.test.ts`
2. `npm test` in `packages/authn`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `authn-local`, `authn-keys`, `authn-token`, `authn-oidc`, `authn-http` (each `cd ../<pkg> && npm test`). They boot the registries through their harnesses; a harness that lists the same strategy name twice now fails with a violation path.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/registry/strategy-registry.ts packages/authn/src/flow/mfa-step-registry.ts packages/authn/test/registry/strategy-registry.test.ts packages/authn/test/flow/mfa.test.ts
git commit -m "refactor(authn): authn.strategies and authn.mfa.steps through @Config and the schema"
```

---

### Task 2.5: `DefaultMfaPolicy` takes `authn.mfa.policy` from `@Config`; its rules move to the schema

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:168-190` (the `mfa` block: `policy` and a new `allOf`)
- Modify: `packages/authn/src/contracts/mfa.ts:1-2, 32-36` (`MfaPolicy` extends `SyncService`)
- Modify: `packages/authn/src/flow/default-mfa-policy.ts:1-56` (imports; delete `readForce` 14-18 and `readRoles` 20-24; constructor 39-56 becomes a field set plus `resolve()`)
- Modify: `packages/users/test/rbac-role-source.test.ts:281, 292` (`new DefaultMfaPolicy(DI.RootContainer, config)` becomes `new DefaultMfaPolicy(DI.RootContainer)`)
- Test: `packages/authn/test/flow/mfa.test.ts` (`DefaultMfaPolicy` describe, lines 121-182)

**Interfaces:**
- Consumes: `@Config`, `SyncService` (`@spinajs/di`; `contracts/` may import `@spinajs/di`, see `test/contracts/boundary.test.ts`), Task 2.4's schema `named` default.
- Produces: `abstract class MfaPolicy extends SyncService`; `DefaultMfaPolicy` with `public get force(): boolean`, `public get forceForRoles(): readonly string[]`, constructor `(container: IContainer)`, `resolve(): void`. Fakes that `extends MfaPolicy` (`EnrolledMfaPolicy`, authn-http and authn-testing test policies) keep working: `SyncService.resolve()` is a default.

What stays in code: `forceForRoles` needs a `RoleSource` and a `PrincipalFactory` registered (a DI lookup). It moves from the constructor to `resolve()` because `@Config` is not readable in the constructor. "force needs steps" becomes two `if/then` rules in the schema. The role list is no longer de-duplicated in code (the `Set` was only a normaliser; `includes` is unaffected by repeats).

- [ ] **Step 1: Schema additions**

Replace the whole `mfa` block (about lines 168-190) with the following. `steps`, `encryptionKey` and `totp` are the current text; the `default` keys, the policy defaults and `allOf` are the changes. Task 2.4's `default: []` on `named` is inherited by `steps`.

```ts
    mfa: {
      type: 'object',
      default: {},
      properties: {
        policy: {
          type: 'object',
          default: {},
          properties: {
            service: { type: 'string', minLength: 1, default: 'DefaultMfaPolicy' },
            force: { type: 'boolean', default: false, description: "Requires a step on logins whose strategy reports method 'password' only (D13): key and OIDC logins get none." },
            forceForRoles: { ...stringList, default: [] },
          },
        },
        steps: { ...named, items: { ...named.items, properties: { ...named.items.properties, name: { type: 'string', minLength: 1, not: { enum: ['recovery'] }, description: "'recovery' is reserved for recovery codes (AuthnService.completeMfa)." } } } },
        encryptionKey: secretRef('AES-256-GCM key for stored MFA secrets; required when any step stores secrets.'),
        totp: {
          type: 'object',
          properties: {
            issuer: { type: 'string', minLength: 1 },
            algorithm: { type: 'string', minLength: 1, description: 'Any name otpauth accepts, e.g. SHA1 (authenticator apps), SHA256, SHA512.' },
            digits: { type: 'integer', minimum: 6, maximum: 10 },
            period: { type: 'integer', minimum: 1 },
            window: { type: 'integer', minimum: 0 },
            recoveryCodes: { type: 'integer', minimum: 0 },
          },
        },
      },
      allOf: [
        // force and forceForRoles both require the first step, so there must be one (DefaultMfaPolicy).
        {
          if: { type: 'object', required: ['policy'], properties: { policy: { type: 'object', required: ['force'], properties: { force: { const: true } } } } },
          then: { required: ['steps'], properties: { steps: { minItems: 1 } } },
        },
        {
          if: { type: 'object', required: ['policy'], properties: { policy: { type: 'object', required: ['forceForRoles'], properties: { forceForRoles: { minItems: 1 } } } } },
          then: { required: ['steps'], properties: { steps: { minItems: 1 } } },
        },
      ],
    },
```
If Ajv strict mode rejects this schema, the Step 3 run says so: fix the schema, not the test.

- [ ] **Step 2: Write the failing tests**

In `flow/mfa.test.ts`, replace the tests `fails boot when force has no step to require` and `fails boot on malformed policy options` (lines 149-156) with:

```ts
    it('refuses force with no step to require, naming authn.mfa.steps', async () => {
      const paths = await violationPaths(boot({ steps: [], mfa: { policy: { force: true } } }));
      assert.ok(paths.includes('authn.mfa.steps'), paths.join(', '));
    });

    it('refuses forceForRoles with no step to require, naming authn.mfa.steps', async () => {
      const paths = await violationPaths(boot({ steps: [], mfa: { policy: { forceForRoles: ['admin'] } } }));
      assert.ok(paths.includes('authn.mfa.steps'), paths.join(', '));
    });

    it('accepts an empty step list while nothing is forced', async () => {
      const p = await boot({ steps: [] });
      assert.deepStrictEqual(await (await policyOf(p)).required(ALICE, PASSWORD), []);
    });

    it('refuses malformed policy options, naming the path of each', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ force: 'yes' }, 'authn.mfa.policy.force'],
        [{ forceForRoles: 'admin' }, 'authn.mfa.policy.forceForRoles'],
        [{ forceForRoles: [''] }, 'authn.mfa.policy.forceForRoles.0'],
        [{ service: '' }, 'authn.mfa.policy.service'],
      ];
      for (const [policy, path] of cases) {
        const paths = await violationPaths(boot({ mfa: { policy } }));
        assert.ok(paths.includes(path), `${JSON.stringify(policy)}: ${paths.join(', ')}`);
      }
    });

    it('takes the policy defaults from the schema', async () => {
      const p = await boot();
      assert.deepStrictEqual(p.configuration.get('authn.mfa.policy'), { service: 'DefaultMfaPolicy', force: false, forceForRoles: [] });
      const policy = await policyOf(p);
      assert.strictEqual(policy.force, false);
      assert.deepStrictEqual(policy.forceForRoles, []);
    });

    it('reads force when it decides, not at boot', async () => {
      const p = await boot();
      const policy = await policyOf(p);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), []);
      p.configuration.set('authn.mfa.policy.force', true);
      assert.deepStrictEqual(await policy.required(ALICE, PASSWORD), ['fake']);
    });
```
The test `fails boot when forceForRoles is set and no RoleSource is registered` stays unchanged (the DI check now runs in `resolve()` but the message is the same). Add `violationPaths` to the harness import.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts`
Expected: FAIL. The two `refuses ... no step` tests fail with `... got InvalidOption` (the constructor still throws by hand), `takes the policy defaults from the schema` fails (`authn.mfa.policy` is `undefined` or lacks `service`/`force`), `reads force when it decides` fails (the constructor snapshots `force`).

- [ ] **Step 4: Implement**

`contracts/mfa.ts`: add `import { SyncService } from '@spinajs/di';` as the first line and change the class header:

```ts
/** DefaultMfaPolicy: required when enrolled; 'force' makes enrolment mandatory. A SyncService so an implementation can check its setup in `resolve()`. */
export abstract class MfaPolicy extends SyncService {
```

`default-mfa-policy.ts`, whole file head and constructor (the `required()` and `forced()` bodies are unchanged except that they read `this.Force`/`this.ForceForRoles` through the getters they already use):

```ts
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import type { IdentityRef } from '../contracts/credentials.js';
import { RoleSource } from '../contracts/hooks.js';
import { MfaPolicy } from '../contracts/mfa.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { PrincipalFactory } from '../contracts/service.js';
import { MfaStepRegistry } from './mfa-step-registry.js';

/**
 * Design §22.3: the steps of `authn.mfa.steps` the identity is enrolled in, for password logins only (D13: a key
 * challenge proves possession and an IdP does its own MFA). When none is enrolled, `force`, or a role of
 * `forceForRoles` (asked through RoleSource), requires the first configured step, so the pending session can only
 * enrol. Boot fails when forceForRoles has no RoleSource or PrincipalFactory to ask; the schema refuses force and
 * forceForRoles with no step to require.
 */
@PerChildInstance()
@Injectable(MfaPolicy)
@Inject(Container)
export class DefaultMfaPolicy extends MfaPolicy {
  @Config('authn.mfa.policy.force')
  protected Force: boolean;

  @Config('authn.mfa.policy.forceForRoles')
  protected ForceForRoles: string[];

  constructor(private readonly container: IContainer) {
    super();
  }

  public get force(): boolean {
    return this.Force === true;
  }

  public get forceForRoles(): readonly string[] {
    return this.ForceForRoles ?? [];
  }

  public resolve(): void {
    if (this.forceForRoles.length > 0) {
      for (const [type, name] of [
        [RoleSource, 'RoleSource'],
        [PrincipalFactory, 'PrincipalFactory'],
      ] as const) {
        if (!this.container.hasRegistered(type as unknown as Class<unknown>)) throw new InvalidOption(`authn.mfa.policy.forceForRoles needs a ${name} to read roles, and none is registered`);
      }
    }
    super.resolve();
  }
```
`required()` is unchanged. In `forced()` replace `this.force`/`this.forceForRoles` reads as they stand (they already use those names). Deleted: `readForce`, `readRoles`, the `Configuration` and `readNamedEntries`/`nonEmpty` imports, the constructor `Configuration` parameter and its steps-empty check. `?? []` and `=== true` are there only for an instance built outside a schema-validated Configuration (the `users` test below); a schema-validated boot always has both values.

`packages/users/test/rbac-role-source.test.ts` lines 281 and 292: `new DefaultMfaPolicy(DI.RootContainer)`. (`config.set([...])` just above stays; the instance reads the root Configuration, the same object.)

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts test/contracts/mfa.test.ts test/contracts/boundary.test.ts`
2. `npm test` in `packages/authn`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `authn-testing` (its `EnrolledMfaPolicy`/`ForcedMfaPolicy` extend `MfaPolicy`), `authn-http`, `users`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/contracts/mfa.ts packages/authn/src/flow/default-mfa-policy.ts packages/authn/test/flow/mfa.test.ts packages/users/test/rbac-role-source.test.ts
git commit -m "refactor(authn): authn.mfa.policy through @Config and the schema, the force rules in the schema"
```

---

### Task 2.6: `DefaultAuthnService` takes linking, the global gate and the policy and throttle names from `@Config`

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:278-284` (`linking` block)
- Modify: `packages/authn/src/service/default-authn-service.ts`: import line 3, `Linking` use (47-50 keeps the interface), `readLinking` (117-124, deleted), fields (172-173), `resolve()` (179-203), line 506-512 (`this.linking`), line 554 (`this.globalGate`), `selectPolicy` (596-609), `selectThrottle` (611-636)
- Test: `packages/authn/test/service/default-authn-service.test.ts` (new tests in the `boot` describe at line 1506, and near the linking tests at 751 and the global-key test at 280)

**Interfaces:**
- Consumes: `@Config`, the `mfa.policy.service` default from Task 2.5, Task 2.1 helpers.
- Produces: `DefaultAuthnService` public API unchanged. New protected members `Linking: Linking`, `ThrottleGlobal: unknown`, `PolicyService: string`, `ThrottleService: string | undefined`, and `private get globalGate(): boolean`.

What stays in code, with the reason: `authnEnvFellBack`, `checkAuthnLegacyKeys` and `checkAuthnSecrets` are plain functions over a `Configuration` and depend on `APP_ENV`, so `resolve()` still resolves the container's Configuration and passes it (Task 2.8 trims their shape checks). Name lookups in DI (`nearestRegistration`, `registeredNames`), the duck-typing of the policy and throttle, and the K6 "only one throttle besides the memory one" selection stay: they are DI checks.

- [ ] **Step 1: Schema additions**

```ts
    linking: {
      type: 'object',
      default: {},
      properties: {
        jit: { type: 'boolean', default: false },
        byVerifiedEmail: { type: 'boolean', default: false },
      },
    },
```
`mfa.policy.service` already got `default: 'DefaultMfaPolicy'` in Task 2.5, and `throttle.global` already has `default: null`. `throttle.service` has no default on purpose: unset triggers the K6 selection.

- [ ] **Step 2: Write the failing tests**

In the `boot` describe (line 1506) add, and add `violationPaths` to the harness import:

```ts
    it('takes the linking switches from the schema defaults', async () => {
      const p = await boot([failing()]);
      assert.deepStrictEqual(p.configuration.get('authn.linking'), { jit: false, byVerifiedEmail: false });
    });

    it('refuses malformed boot options, naming the path of each', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ linking: { jit: 'maybe' } }, 'authn.linking.jit'],
        [{ linking: 'on' }, 'authn.linking'],
        [{ mfa: { policy: { service: '' } } }, 'authn.mfa.policy.service'],
        [{ throttle: { service: '' } }, 'authn.throttle.service'],
      ];
      for (const [authn, path] of cases) {
        const paths = await violationPaths(boot([failing()], {}, { authn }));
        assert.ok(paths.includes(path), `${JSON.stringify(authn)}: ${paths.join(', ')}`);
      }
    });

    it('reads authn.linking when it decides, not at boot', async () => {
      const p = await bootLinking({});
      await seedAlice(p);
      p.configuration.set('authn.linking.jit', true);
      const r = await p.service.authenticate(external, ctx());
      assert.strictEqual(r.status, 'success');
    });

    it('adds the global key as soon as authn.throttle.global is set', async () => {
      const p = await boot([strategy('g', { verify: () => ({ ok: false, reason: 'invalid_credentials' }) })]);
      p.configuration.set('authn.throttle.global', { free: 100, baseDelayMs: 1, maxDelayMs: 1 });
      await p.service.authenticate(bearer('x'), ctx());
      assert.ok(throttle!.attempts[0].keys.some((k) => k.kind === 'global'));
    });
```
`bootLinking`, `seedAlice`, `external`, `strategy`, `bearer` and `failing` are the helpers already in this file; the linking test needs `external` and `bootLinking`, which are declared inside `describe('per-request strategies ...')` at lines 745-751: define the `reads authn.linking when it decides` test inside that describe (next to `bootLinking`) and the other three in the `boot` describe. For `reads authn.linking`, `bootLinking({})` uses the default fake store, which provisions only when `jit` is on and the subject has `emailVerified`; if the fake needs a verified subject, build `p.externalSubjects.set('sub-1', subject())` exactly as `bootLinking` does with its default argument.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/service/default-authn-service.test.ts`
Expected: FAIL. `takes the linking switches from the schema defaults` fails (`authn.linking` is undefined), `refuses malformed boot options` fails with `... got InvalidOption` (the hand readers throw) for the `linking` and `service` cases, and both `... when it decides` / `as soon as ... is set` tests fail (the values are read once at boot).

- [ ] **Step 4: Implement**

Import: `import { Config, Configuration } from '@spinajs/configuration';`.

Delete `readLinking` (lines 117-124). Replace the fields `linking`/`globalGate` (172-173) and the constructor/`resolve()` (175-203):

```ts
  @Config('authn.linking')
  protected Linking: Linking;

  @Config('authn.throttle.global')
  protected ThrottleGlobal: unknown;

  @Config('authn.mfa.policy.service')
  protected PolicyService: string;

  @Config('authn.throttle.service')
  protected ThrottleService: string | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  private get globalGate(): boolean {
    return isObject(this.ThrottleGlobal);
  }

  public async resolve(): Promise<void> {
    // The boot checks are plain functions over a Configuration and read APP_ENV, so they cannot use @Config.
    const configuration = await this.container.resolve(Configuration);
    if (authnEnvFellBack(configuration)) warnOnce(AUTHN_ENV_FALLBACK_WARNING);
    checkAuthnLegacyKeys(configuration, { warn: warnOnce });
    await checkAuthnSecrets(configuration, this.container, warnOnce);
    this.registry = await this.container.resolve(StrategyRegistry);
    this.auditor = await this.container.resolve(AuthnAudit);
    this.identities = (await this.neighbour(IdentityStore, 'IdentityStore', true))!;
    this.principals = (await this.neighbour(PrincipalFactory, 'PrincipalFactory', true))!;
    this.links = await this.neighbour(IdentityLinkStore, 'IdentityLinkStore', false);
    if (this.registry.strategies().some((s) => s.interactive)) {
      this.sessions = await this.neighbour(SessionIssuer, 'SessionIssuer', true);
      this.steps = await this.container.resolve(MfaStepRegistry);
      this.policy = await this.selectPolicy();
    }
    this.throttle = await this.selectThrottle();
    if (canPeek(this.throttle)) this.peeker = this.throttle;
    else if (this.registry.strategies().some((s) => !s.interactive)) warnOnce(NO_PEEK_WARNING);
    await super.resolve();
  }
```
Lines 506-512: `this.linking.jit` and `this.linking.byVerifiedEmail` become `this.Linking.jit` and `this.Linking.byVerifiedEmail` (three places). Line 554 `this.globalGate` is unchanged (now the getter).

`selectPolicy` and `selectThrottle` lose their parameter and their string check:

```ts
  private async selectPolicy(): Promise<MfaPolicy> {
    const name = this.PolicyService;
    const type = nearestRegistration(this.container, MfaPolicy, name);
    if (!type) {
      const listed = registeredNames(this.container, MfaPolicy).map(q).join(', ') || 'none';
      throw new InvalidOption(`authn.mfa.policy.service ${q(name)}: no MfaPolicy is registered under that name (registered: ${listed})`);
    }
    const policy: unknown = await instantiate(this.container, type);
    if (!isObject(policy) || typeof policy.required !== 'function') throw new InvalidOption(`authn.mfa.policy.service ${q(name)} is not an MfaPolicy`);
    return policy as unknown as MfaPolicy;
  }

  private async selectThrottle(): Promise<AuthnThrottle> {
    const names = registeredNames(this.container, AuthnThrottle);
    const listed = names.map(q).join(', ') || 'none';
    let name = this.ThrottleService;
    if (name === undefined) {
      // The core always registers the memory throttle; one more registered throttle is the one the app imported (K6).
      const others = names.filter((n) => n !== MEMORY_THROTTLE);
      const only = names.length === 1 ? names : others.length === 1 ? others : [];
      if (only.length !== 1) {
        throw new InvalidOption(`authn.throttle.service is not set and ${names.length === 0 ? 'no AuthnThrottle is' : 'several are'} registered (${listed}); name one`);
      }
      name = only[0];
    }
    const type = nearestRegistration(this.container, AuthnThrottle, name);
    if (!type) {
      throw new InvalidOption(`authn.throttle.service ${q(name)}: no AuthnThrottle is registered under that name (registered: ${listed}). Install the package that provides it (DbAuthnThrottle: @spinajs/authn-orm); MemoryAuthnThrottle suits a single instance only`);
    }
    const throttle: unknown = await instantiate(this.container, type);
    if (!isObject(throttle) || typeof throttle.attempt !== 'function' || typeof throttle.succeed !== 'function') {
      throw new InvalidOption(`authn.throttle.service ${q(name)} is not an AuthnThrottle`);
    }
    return throttle as unknown as AuthnThrottle;
  }
```
Remove the `DEFAULT_MFA_POLICY` constant (line 41; the schema owns the default) and the `InvalidArgument` import only if it is no longer used (grep before deleting; `InvalidOperation` and `InvalidOption` are still used). A `null` for either service name is now a violation (`coerceTypes` makes it `''`, which fails `minLength`), where the old code treated it as unset.

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/service/default-authn-service.test.ts test/boot/legacy-keys.test.ts test/boot/secrets.test.ts`
2. `npm test` in `packages/authn`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `authn-http`, `authn-oidc`, `users`.

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/service/default-authn-service.ts packages/authn/test/service/default-authn-service.test.ts
git commit -m "refactor(authn): linking, global throttle and service names through @Config and the schema"
```

---

### Task 2.7: `MemoryAuthnThrottle` takes `authn.throttle` from `@Config`

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:238` (`throttle.properties.maxRows`)
- Modify: `packages/authn/src/throttle/params.ts:1-144` (keep lines 1-47 types, `THROTTLE_FLOWS`, `DEFAULT_THROTTLE_PARAMS`, `backoffDelayMs`, `DEFAULT_THROTTLE_MAX_ROWS`; delete lines 48-144; add `ThrottleConfig`)
- Modify: `packages/authn/src/throttle/memory-throttle.ts:3-93` (imports, `isConfiguration` at 54, class header 68-93)
- Modify: `packages/authn/test/behaviour/harness.ts` (`CoreOptions.throttle` at line 35, default at line 191)
- Modify: `packages/authn/test/service/default-authn-service.test.ts` (line 17 `RecordingThrottle` stays; line 126 `throttle:` and line 491)
- Modify: `packages/authn-oidc/test/core.test.ts:75`, `packages/authn-http/test/v3-app/behaviour/harness.ts:464`
- Test: `packages/authn/test/throttle/memory-throttle.test.ts` (lines 556-570 and the DI/boot describe 592-669), `packages/authn/test/boot/config-defaults.test.ts` (lines 55-57 and the `maxRows` test at 79-83)
- NOT touched: `packages/authn-orm/src/throttle/params.ts` and `db-throttle.ts` (a separate copy used by `DbAuthnThrottle`; a later phase).

**Interfaces:**
- Consumes: `@Config`, `pinConfiguration` and `configuredChild` from Task 2.1.
- Produces:
  - `type ThrottleConfig = ThrottleParams & { readonly service?: string; readonly maxRows?: number }` (exported from `throttle/params.ts`)
  - `MemoryAuthnThrottle` constructor `(explicit?: ThrottleParams, options?: MemoryThrottleOptions)`; `public get params(): ThrottleParams`; `public get maxRows(): number`
  - `CoreOptions.throttle?: (configuration: Configuration, child: IContainer) => AuthnThrottle`
  - Removed from the barrel: `readThrottleConfig`, `checkThrottleParams`, `checkMaxRows`. Kept: `DEFAULT_THROTTLE_PARAMS` and `DEFAULT_THROTTLE_MAX_ROWS` as the defaults of the explicit-params test seam, each guarded by a test that they equal the schema default.

`@Config` cannot serve the explicit-params form. Dozens of tests (here, in `authn-keys`, `authn-token`, `authn-local`) build `new MemoryAuthnThrottle(params)` with no Configuration at all, so that seam stays: explicit params are trusted and unvalidated (the types say what they are), and `maxRows` falls back to `DEFAULT_THROTTLE_MAX_ROWS`. Built with no params, the instance reads its configuration through `@Config`: the root Configuration (the app runs it as a root singleton) or the container given to `pinConfiguration` (tests). The values are snapshotted on first use because the per-flow tables and their eviction assume fixed limits.

- [ ] **Step 1: Schema additions**

```ts
        maxRows: { type: 'integer', minimum: 4, maximum: 16000000, default: 1000000, description: 'Rows a MemoryAuthnThrottle keeps per flow (memory grows with 4 × maxRows).' },
```
The throttle block already has `default: {}`, so an unset `authn.throttle` gets every default including this one.

- [ ] **Step 2: Write the failing tests**

`config-defaults.test.ts`: replace the `keeps the throttle block equal to the schema defaults` test (lines 55-58) and the `takes maxRows per throttle flow ... with no default` test (lines 79-83):

```ts
  it('keeps the throttle block equal to the schema defaults, maxRows aside', () => {
    const { maxRows, ...limits } = check({}).config.throttle;
    expect(maxRows).to.eq(DEFAULT_THROTTLE_MAX_ROWS);
    expect(authn.throttle).to.deep.eq(limits);
    expect(limits).to.deep.eq(clone(DEFAULT_THROTTLE_PARAMS));
  });
```
```ts
  it('takes maxRows per throttle flow, 4 to 16,000,000, 1,000,000 by default', () => {
    expect(check({ throttle: { maxRows: 5000 } }).ok).to.eq(true);
    expect(check({}).config.throttle.maxRows).to.eq(1_000_000);
    for (const bad of [3, 16_000_001, 1.5]) expect(check({ throttle: { maxRows: bad } }).paths, String(bad)).to.include('/throttle/maxRows');
  });
```
and add `DEFAULT_THROTTLE_MAX_ROWS` to that file's `../../src/index.js` import.

`memory-throttle.test.ts`: delete the test `rejects a maxRows out of range` (lines 561-566; the `options.maxRows` override is a trusted seam and the range is a schema rule) and the test `rejects explicit params without a flow` (lines 666-669). Replace the whole second describe that starts at line 592 (the root-DI `boot(throttle)` scaffolding with `ThrottleTestConfiguration`; read lines 586-600 for its exact opening) with:

```ts
  describe('configuration', () => {
    const kids: IContainer[] = [];

    afterEach(async () => {
      for (const c of kids.splice(0)) await c.dispose();
    });

    async function bootWith(throttle?: unknown): Promise<MemoryAuthnThrottle> {
      const child = await configuredChild({ authn: throttle === undefined ? {} : { throttle } });
      kids.push(child);
      return pinConfiguration(new MemoryAuthnThrottle(), child);
    }

    it('uses the schema defaults without authn.throttle', async () => {
      const t = await bootWith();
      assert.deepStrictEqual(t.params, DEFAULT_THROTTLE_PARAMS);
      assert.strictEqual(t.maxRows, DEFAULT_THROTTLE_MAX_ROWS);
    });

    it('merges authn.throttle over the defaults per flow and key', async () => {
      const over = { login: { account: { free: 2, baseDelayMs: 1000, maxDelayMs: 60000 } }, reauth: { ip: { free: 4, baseDelayMs: 500, maxDelayMs: 8000 } }, resetAfterSeconds: 600, global: { free: 100, baseDelayMs: 10, maxDelayMs: 1000 } };
      const t = await bootWith({ service: 'MemoryAuthnThrottle', ...over });
      assert.deepStrictEqual(t.params, throttleParams({ authn: { throttle: over } } as Parameters<typeof throttleParams>[0]));
      const k = pwKeys('cfg@example.test', IP_A);
      for (let i = 0; i < 2; i++) expectAllowed(await t.attempt(k, 'login', ctx()));
      expectRefused(await t.attempt(k, 'login', ctx()), 1);
    });

    it('reads maxRows from authn.throttle', async () => {
      assert.strictEqual((await bootWith({ maxRows: 5000 })).maxRows, 5000);
    });

    it('reads the configuration once, on first use: the tables assume fixed limits', async () => {
      const child = await configuredChild({ authn: { throttle: { maxRows: 5000 } } });
      kids.push(child);
      const t = pinConfiguration(new MemoryAuthnThrottle(), child);
      assert.strictEqual(t.maxRows, 5000);
      child.get(Configuration)!.set('authn.throttle.maxRows', 6000);
      assert.strictEqual(t.maxRows, 5000);
    });

    it('takes explicit params without any Configuration', () => {
      const t = new MemoryAuthnThrottle(DEFAULT_THROTTLE);
      assert.strictEqual(t.params, DEFAULT_THROTTLE);
      assert.strictEqual(t.maxRows, DEFAULT_THROTTLE_MAX_ROWS);
    });

    const refused: [string, unknown, string][] = [
      ['a list', [], 'authn.throttle'],
      ['an unknown key', { logn: {} }, 'authn.throttle.logn'],
      ['an unknown key kind', { login: { acount: { free: 1, baseDelayMs: 1, maxDelayMs: 1 } } }, 'authn.throttle.login.acount'],
      ['an unknown backoff field', { login: { account: { free: 1, base: 1 } } }, 'authn.throttle.login.account.base'],
      ['a negative free', { login: { account: { free: -1, baseDelayMs: 1000, maxDelayMs: 60000 } } }, 'authn.throttle.login.account.free'],
      ['a fractional delay', { mfa: { ip: { free: 20, baseDelayMs: 1.5, maxDelayMs: 300000 } } }, 'authn.throttle.mfa.ip.baseDelayMs'],
      ['a zero maxDelayMs', { reset: { account: { free: 1, baseDelayMs: 60000, maxDelayMs: 0 } } }, 'authn.throttle.reset.account.maxDelayMs'],
      ['an incomplete new key', { reauth: { ip: { free: 1 } } }, 'authn.throttle.reauth.ip.baseDelayMs'],
      ['a zero resetAfterSeconds', { resetAfterSeconds: 0 }, 'authn.throttle.resetAfterSeconds'],
      ['a malformed global', { global: { free: 1 } }, 'authn.throttle.global.baseDelayMs'],
      ['a zero maxRows', { maxRows: 0 }, 'authn.throttle.maxRows'],
      ['a maxRows below 4', { maxRows: 3 }, 'authn.throttle.maxRows'],
      ['a maxRows above 16,000,000', { maxRows: 16_000_001 }, 'authn.throttle.maxRows'],
      ['a fractional maxRows', { maxRows: 1.5 }, 'authn.throttle.maxRows'],
      // The schema requires all three fields of a given backoff key.
      ['a partial backoff key', { login: { account: { free: 2 } } }, 'authn.throttle.login.account.baseDelayMs'],
      ['a partial ip key', { mfa: { ip: { free: 20, baseDelayMs: 1000 } } }, 'authn.throttle.mfa.ip.maxDelayMs'],
    ];
    for (const [what, bad, path] of refused) {
      it(`fails boot on ${what}, naming ${path}`, async () => {
        const paths = await violationPaths(configuredChild({ authn: { throttle: bad } }));
        assert.ok(paths.includes(path), paths.join(', '));
      });
    }
  });

  describe('DI', () => {
    // The root-container scaffolding of the old describe (ThrottleTestConfiguration, before/after/afterEach) stays for this test only.
    it('resolves through DI as one instance registered as AuthnThrottle', async () => {
      cfg.set('authn.throttle', {});
      const t = await DI.resolve(MemoryAuthnThrottle);
      assert.strictEqual(await DI.resolve(MemoryAuthnThrottle), t);
      assert.ok((DI.getRegisteredTypes(AuthnThrottle) ?? []).includes(MemoryAuthnThrottle));
    });
  });
```
Add to the file's imports: `import { Configuration } from '@spinajs/configuration'` (if not already there), `import type { IContainer } from '@spinajs/di'`, `import { DEFAULT_THROTTLE_MAX_ROWS } from '../../src/index.js'`, and `configuredChild, pinConfiguration, violationPaths` from `'../behaviour/harness.js'`. Keep `ThrottleTestConfiguration`, its `before`/`after`/`afterEach` and `cfg` in a describe of their own wrapping only the `DI` test. `InvalidOption` stays imported only if another test in the file still uses it (check before removing). The string-number case (`free: '20'`) is dropped: `coerceTypes` accepts it.

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/throttle/memory-throttle.test.ts test/boot/config-defaults.test.ts`
Expected: FAIL at compile time first (`pinConfiguration` ok from 2.1, but `new MemoryAuthnThrottle()` with no argument is a TS error: the constructor needs a source), and once that compiles, `takes the schema defaults` fails (`maxRows` and the schema default are absent), every `fails boot on ...` case fails with `got InvalidOption`, and the `maxRows ... 1,000,000 by default` assertion in config-defaults fails (`undefined`).

- [ ] **Step 4: Implement**

`throttle/params.ts`: delete from `const MAX_ROWS_RANGE` through the end of the file (`MAX_ROWS_RANGE`, `TOP_KEYS`, `CONFIG_KEYS`, `KINDS`, `FIELDS`, `MIN`, `kindOf`, `isRecord`, `record`, `readBackoff`, `readFlow`, `readResetAfter`, `readThrottleConfig`, `checkThrottleParams`, `checkMaxRows`) and the `InvalidOption` import (line 1). Keep `DEFAULT_THROTTLE_MAX_ROWS` and rewrite its comment. After `ThrottleParams` add:

```ts
/** `authn.throttle` as the schema delivers it: the limits, plus the service name and the row cap. */
export type ThrottleConfig = ThrottleParams & { readonly service?: string; readonly maxRows?: number };
```
and over `DEFAULT_THROTTLE_PARAMS` and `DEFAULT_THROTTLE_MAX_ROWS` keep one line each: `// Same values as the schema defaults (test/boot/config-defaults.test.ts); the fallback of explicit params.`

`throttle/memory-throttle.ts`:

```ts
import { createHmac, randomBytes } from 'node:crypto';

import { DI, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';

import { AuthnThrottle } from '../contracts/throttle.js';
import type { ThrottleFlow, ThrottleKey } from '../contracts/throttle.js';
import type { AuthnContext } from '../contracts/credentials.js';
import { DEFAULT_THROTTLE_MAX_ROWS, THROTTLE_FLOWS, backoffDelayMs } from './params.js';
import type { BackoffParams, ThrottleConfig, ThrottleFlowParams, ThrottleParams } from './params.js';
import type { PeekableThrottle } from './peek.js';
```
Delete `isConfiguration` (line 54). Class header:

```ts
@Singleton()
@Injectable(AuthnThrottle)
export class MemoryAuthnThrottle extends AuthnThrottle implements PeekableThrottle {
  @Config('authn.throttle')
  protected Throttle: ThrottleConfig;

  protected readonly tables: Readonly<Record<ThrottleFlow, ThrottleTable>>;
  protected sweepBatch = SWEEP_BATCH;
  private readonly secret = randomBytes(32);
  private seq = 0;
  private loaded: { readonly params: ThrottleParams; readonly maxRows: number | undefined } | undefined;

  /** DI passes nothing and the limits come from `authn.throttle`; tests pass complete, trusted params. */
  constructor(private readonly explicit?: ThrottleParams, private readonly options: MemoryThrottleOptions = {}) {
    super();
    const table = (): ThrottleTable => ({ rows: new Map(), cursor: undefined, fullUntilMs: 0, fullReported: false });
    this.tables = Object.freeze({ login: table(), mfa: table(), reset: table(), reauth: table() });
  }

  public get params(): ThrottleParams {
    return this.explicit ?? this.configured.params;
  }

  public get maxRows(): number {
    return this.options.maxRows ?? (this.explicit ? undefined : this.configured.maxRows) ?? DEFAULT_THROTTLE_MAX_ROWS;
  }

  // Read once: the tables and their eviction assume fixed limits.
  private get configured(): { readonly params: ThrottleParams; readonly maxRows: number | undefined } {
    if (!this.loaded) {
      const { service: _service, maxRows, ...params } = this.Throttle;
      this.loaded = { params, maxRows };
    }
    return this.loaded;
  }
```
The rest of the class (`attempt`, `peek`, `succeed`, helpers) is unchanged: it already reads `this.params` and `this.maxRows`. In the `MemoryThrottleOptions` doc keep "Overrides `authn.throttle.maxRows`." Update the class doc's "default 1,000,000" to "schema default 1,000,000".

Test seams and the three call sites of the removed Configuration form:
- `test/behaviour/harness.ts` line 35: `readonly throttle?: (configuration: Configuration, child: IContainer) => AuthnThrottle;` and its doc "from the child's Configuration" stays true. Line 191 becomes:
  ```ts
      const throttle = (opts.throttle ?? ((_c, k) => pinConfiguration(new MemoryAuthnThrottle(), k)))(configuration, child);
  ```
- `test/service/default-authn-service.test.ts` line 126: `throttle: (_c: Configuration, k: IContainer) => (throttle = pinConfiguration(new RecordingThrottle(), k)),` and line 491: `throttle: (_c, k) => new NoPeek(pinConfiguration(new MemoryAuthnThrottle(), k))`. Add `pinConfiguration` to the harness import; the other `new RecordingThrottle(DEFAULT_THROTTLE_PARAMS)` calls (lines 1511-1540) stay.
- `packages/authn-oidc/test/core.test.ts` line 75: `bind(child, AuthnThrottle, 'MemoryAuthnThrottle', new MemoryAuthnThrottle(DEFAULT_THROTTLE_PARAMS));` and import `DEFAULT_THROTTLE_PARAMS` from `@spinajs/authn` (its Configuration sets no throttle values, so the defaults are what it ran with). Remove the now-unused `const configuration = await child.resolve(Configuration)` only if nothing else uses it.
- `packages/authn-http/test/v3-app/behaviour/harness.ts` line 464: `fakes.throttle = new MemoryAuthnThrottle();` (reads the root Configuration, the object `config()` returned). If the authn-http root Configuration has no `authn.throttle` (it relies on the shipped `lib` config), this fails on first use with a destructuring error: then pass `DEFAULT_THROTTLE_PARAMS` there as well.

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/throttle/memory-throttle.test.ts test/boot/config-defaults.test.ts test/service/default-authn-service.test.ts`
2. `npm test` in `packages/authn` (includes `test/mutation/core-mutants.test.ts`, which subclasses the throttle and takes long).
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `authn-oidc`, `authn-http`, `authn-keys`, `authn-token`, `authn-local`. (`authn-orm` has its own `ThrottleParams` copy and is unaffected; run it once at the end of the phase.)

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/throttle/params.ts packages/authn/src/throttle/memory-throttle.ts packages/authn/test/behaviour/harness.ts packages/authn/test/service/default-authn-service.test.ts packages/authn/test/throttle/memory-throttle.test.ts packages/authn/test/boot/config-defaults.test.ts packages/authn-oidc/test/core.test.ts packages/authn-http/test/v3-app/behaviour/harness.ts
git commit -m "refactor(authn): authn.throttle through @Config and the schema, no hand validation"
```

---

### Task 2.8: The boot checks keep only what a schema cannot express

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:82-88` (`config` block) and `:109-124` (`local.pepper` extras)
- Modify: `packages/authn/src/service/boot/secrets.ts:1-114` (delete `isObject`, `isVersion`, `pepperFindings`, the shape branches of `authnSecretFindings`; add the `'schema'` topic at line 11)
- Modify: `packages/authn/src/service/boot/legacy-keys.ts:19, 55-64` (`rejectsAuthnLegacyKeys`)
- Modify: `packages/authn/src/service/boot/check-config.ts:1-47` (imports, `strategyFindings`, the head of `checkAuthnConfig`)
- Modify: `packages/authn/src/registry/named.ts:16-45` (delete `readNamedEntries`; keep `NamedEntry`, `q`, `nonEmpty`, `kindOf` and the rest)
- Test: `packages/authn/test/boot/config-defaults.test.ts`, `packages/authn/test/boot/secrets.test.ts` (lines 243-289), `packages/authn/test/boot/legacy-keys.test.ts` (lines 119-130, 148-158), `packages/authn/test/boot/check-config.test.ts` (lines 82-88 and a new test)

**Interfaces:**
- Consumes: Tasks 2.4 and 2.5 (the last callers of `readNamedEntries` are gone), `InvalidConfiguration` from `@spinajs/configuration`, Task 2.1 helpers.
- Produces:
  - `AuthnConfigFinding.topic` gains `'schema'`.
  - `rejectsAuthnLegacyKeys(config: AuthnConfigSource): boolean` (no longer throws on a non-boolean).
  - `authnSecretFindings` and `checkAuthnSecrets` keep their signatures and drop the type errors.
  - `checkAuthnConfig(container)` returns `topic: 'schema'` error findings (one per violation, `message: '<path> <ajv message>'`) when the container's Configuration fails to resolve with `InvalidConfiguration`, instead of throwing.
  - Removed from the barrel: `readNamedEntries`.

What stays in code, and why: everything that reads `APP_ENV` (`authnAppEnv`, `isLenientAuthnEnv`, `authnEnvFellBack`, the lenient/strict split, `weak()`); the public-cookie-secret comparison; "the MFA key is missing while a configured step stores secrets" (asks the DI-resolved steps); the empty-string pepper warning (the schema allows `''`); `http.cookie.secret` type check (that key belongs to the `http` schema of Phase 3); the 2.x `rbac` tree detector. These functions are plain functions over a `Configuration`, so `@Config` cannot serve them: `DefaultAuthnService.resolve()` (Task 2.6) hands them the container's Configuration.

- [ ] **Step 1: Schema additions**

`config` block:

```ts
    config: {
      type: 'object',
      default: {},
      properties: {
        rejectLegacyKeys: { type: 'boolean', default: false, description: 'Fail boot on a 2.x key of the old-key table.' },
      },
    },
```

`local.pepper` extras (the object passed as second argument of `secretRef(...)`):

```ts
          version: { type: 'integer', minimum: 1, maximum: 999999999, default: 1, description: 'Stored in the hash prefix so the pepper can rotate.' },
          previous: {
            type: 'array',
            description: 'Older peppers, so a hash made under one still verifies and is rehashed (A03). Each version differs from the others and from `version`.',
            uniqueItemProperties: ['version'],
            items: {
              type: 'object',
              properties: {
                secret: { type: 'string', minLength: 1 },
                // 3/version: up from the item's version (1), the item (2) and the previous list (3) to the pepper's own version.
                version: { type: 'integer', minimum: 1, not: { const: { $data: '3/version' } } },
              },
              required: ['secret', 'version'],
            },
          },
```
Fallback if Step 3 shows Ajv refusing the relative `$data` pointer or not applying the default first: drop the `not` line and keep this clash check in `authnSecretFindings` (it is a cross-field rule that ran before, so behaviour is the same):

```ts
  const current = pepper?.version ?? 1;
  if (pepper?.previous?.some((p) => p.version === current)) error(`authn.local.pepper.previous: each version must differ from authn.local.pepper.version (${current})`);
```

- [ ] **Step 2: Write the failing tests**

`config-defaults.test.ts`: in `appAjv()` add `$data: true` to the Ajv options (mirrors `initValidator`). Add inside `describe('authn schema (task 8 edits)', ...)`:

```ts
  it('caps the pepper version and refuses a previous version equal to the current one, implicit 1 included', () => {
    expect(check({ local: { pepper: { secret: 'x', version: 999999999 } } }).ok).to.eq(true);
    expect(check({ local: { pepper: { secret: 'x', version: 1000000000 } } }).paths).to.include('/local/pepper/version');
    expect(check({ local: { pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 2 }] } } }).paths).to.include('/local/pepper/previous/0/version');
    expect(check({ local: { pepper: { secret: 'x', previous: [{ secret: 'y', version: 1 }] } } }).paths).to.include('/local/pepper/previous/0/version');
    expect(check({ local: { pepper: { secret: 'x', version: 3, previous: [{ secret: 'y', version: 2 }, { secret: 'z', version: 1 }] } } }).ok).to.eq(true);
  });

  it('gives authn.config its default', () => {
    expect(check({}).config.config).to.deep.eq({ rejectLegacyKeys: false });
  });

  it('names the pepper and MFA key paths in full on a boot', async () => {
    const paths = await violationPaths(configuredChild({ authn: { local: { pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 2 }] } }, mfa: { encryptionKey: { secret: {} } } } }));
    expect(paths).to.include('authn.local.pepper.previous.0.version');
    expect(paths).to.include('authn.mfa.encryptionKey.secret');
  });
```
(add `violationPaths` and `configuredChild` to the harness import of that file.) The existing test `takes previous peppers as { secret, version } with distinct versions` keeps passing: its repeated-version case still fails on `/local/pepper/previous`.

`secrets.test.ts`: delete `refuses a key that is not a string in any env` (243-245), `refuses an empty previous pepper in every env, as the schema does` (266-270), `refuses a previous version equal to the current one or repeated, in any env` (272-279) and `refuses malformed pepper settings in any env` (281-289); the schema owns them (covered above and by `config-defaults.test.ts`). Add in the `pepper` describe:

```ts
    it('leaves the shape of the pepper and the MFA key to the schema', async () => {
      expect(await findings('production', values({ mfaKey: 42 }))).to.deep.eq([]);
      expect(await findings('production', values({ pepper: { secret: STRONG, version: 0, previous: {} } }))).to.deep.eq([]);
    });
```

`legacy-keys.test.ts`: replace `refuses a rejectLegacyKeys that is not a boolean` (119-129) with:

```ts
    it('treats only an explicit true as rejecting; the schema refuses other values', () => {
      for (const v of ['true', 1, null, undefined]) {
        expect(() => checkAuthnLegacyKeys(config({ rbac: { session: { service: 'MemorySessionStore' } }, authn: { config: { rejectLegacyKeys: v } } }), log()), String(v)).to.not.throw();
      }
    });
```
and in `describe('DefaultAuthnService boot: legacy keys')` replace `fails boot on a malformed authn.config` (148-158) with:

```ts
  it('refuses a malformed authn.config through the schema, naming the path', async () => {
    const paths = await violationPaths(buildCore({}, { raw: { authn: { config: { rejectLegacyKeys: 'yes' } } } }));
    expect(paths).to.include('authn.config.rejectLegacyKeys');
  });
```
(add `violationPaths` to the harness import; `InvalidOption` stays imported for the test above it.)

`check-config.test.ts`: replace `reports a malformed list without echoing it` (82-88) with the two tests below, and import `useAuthnSchema` from the harness:

```ts
    it('does not re-check the list shape: the schema refuses a bad list before the Configuration resolves', async () => {
      const f = await check(merge(sound(), { authn: { strategies: [{ name: 'local', service: 'KitPassword' }] } }));
      expect(topics(f)).to.deep.eq([]);
    });

    it('reports a schema violation as an error finding without echoing the value, instead of throwing', async () => {
      const child = DI.RootContainer.child();
      children.push(child);
      useAuthnSchema(child);
      child.register(configurationOf(merge(sound(), { authn: { strategies: [{ name: 'local', service: 'KitPassword', secret: 'hunter2' }, { name: 'local', service: 'Other' }] } }), 'production', true)).as(Configuration);
      const f = await checkAuthnConfig(child);
      expect(topics(f)).to.include('schema:error');
      expect(f.map((x) => x.message).join(' ')).to.contain('authn.strategies').and.not.contain('hunter2');
    });
```

- [ ] **Step 3: Run and confirm RED**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/config-defaults.test.ts test/boot/secrets.test.ts test/boot/legacy-keys.test.ts test/boot/check-config.test.ts`
Expected: FAIL. `caps the pepper version ...` fails (`/local/pepper/version` is not reported: no maximum), `gives authn.config its default` fails (`undefined`), `names the pepper and MFA key paths in full` fails (the clash is not a schema rule yet), `leaves the shape ... to the schema` fails (the code still reports errors), `treats only an explicit true ...` fails (`rejectsAuthnLegacyKeys` throws `InvalidOption`), and `reports a schema violation as an error finding` fails (`checkAuthnConfig` throws `InvalidConfiguration`, and `'schema'` is not a topic).

- [ ] **Step 4: Implement**

`secrets.ts`: topic and the shrunken checks (keep `safeMessage`, `secretStoringSteps`, `SecretStoringSteps`, `checkAuthnSecrets` and the `kindOf`, `absent`, `q` helpers that the cookie check still uses; delete `isObject`, `isVersion`, `pepperFindings`):

```ts
export interface AuthnConfigFinding {
  readonly topic: 'strategies' | 'secrets' | 'proxy' | 'cors' | 'env' | 'mfa' | 'legacy' | 'schema';
  readonly level: 'error' | 'warning';
  readonly message: string;
}
```

```ts
export async function authnSecretFindings(config: AuthnConfigSource, steps: SecretStoringSteps): Promise<AuthnConfigFinding[]> {
  const env = authnAppEnv(config);
  const lenient = isLenientAuthnEnv(env);
  const out: AuthnConfigFinding[] = [];
  const error = (message: string): void => {
    out.push({ topic: 'secrets', level: 'error', message });
  };
  const weak = (message: string): void => {
    out.push({ topic: 'secrets', level: lenient ? 'warning' : 'error', message: lenient ? message : `${message} (env ${q(env ?? 'unset')})` });
  };

  const cookie = config.get<unknown>('http.cookie.secret');
  if (!absent(cookie) && typeof cookie !== 'string') error(`http.cookie.secret must be a string, got ${kindOf(cookie)}`);
  else if (!cookie) weak('http.cookie.secret is not set: signed cookies and sessions cannot be trusted');
  else if (cookie === AUTHN_PUBLIC_COOKIE_SECRET) weak('http.cookie.secret is the public default @spinajs/http ships; set your own');

  // The shape of both keys is the schema's; only what depends on the env and on the configured steps is checked here.
  if (!config.get<{ secret?: string | null } | undefined>('authn.mfa.encryptionKey')?.secret) {
    let storing: readonly string[] = [];
    try {
      storing = await steps();
    } catch (e) {
      weak(`authn.mfa.encryptionKey.secret is not set and the MFA steps cannot be resolved to tell whether they store secrets: ${safeMessage(e, 'resolving the MFA steps')}`);
    }
    if (storing.length > 0) weak(`authn.mfa.encryptionKey.secret is not set, but the MFA step(s) ${storing.map(q).join(', ')} store secrets`);
  }

  // null turns the pepper off; an empty string is a pepper that adds nothing.
  if (config.get<{ secret?: string | null } | undefined>('authn.local.pepper')?.secret === '') weak('authn.local.pepper.secret is empty; set a value, or null to turn the pepper off');
  return out;
}
```
`error` is still used by the cookie check, so it stays.

`legacy-keys.ts`:

```ts
/** `authn.config.rejectLegacyKeys`; false unless it is true (the schema refuses any other value). */
export function rejectsAuthnLegacyKeys(config: AuthnConfigSource): boolean {
  return config.get<boolean | undefined>('authn.config.rejectLegacyKeys') === true;
}
```
Delete the file-local `kindOf` (line 19); `isObject` is still used by `leaves`; `InvalidOption` is still used by `checkAuthnLegacyKeys`.

`check-config.ts`:

```ts
import type { IContainer } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';

import { AuthenticationStrategy } from '../../contracts/strategy.js';
import { nearestRegistration, q } from '../../registry/named.js';
import type { NamedEntry } from '../../registry/named.js';
import { AUTHN_ENV_FALLBACK_WARNING, authnEnvFellBack } from './env.js';
import type { AuthnConfigSource } from './env.js';
import { authnLegacyKeysText, findAuthnLegacyKeys, rejectsAuthnLegacyKeys } from './legacy-keys.js';
import { authnSecretFindings, safeMessage, secretStoringSteps } from './secrets.js';
import type { AuthnConfigFinding } from './secrets.js';

function strategyFindings(container: IContainer, config: AuthnConfigSource): AuthnConfigFinding[] {
  const entries = config.get<NamedEntry[] | undefined | null>('authn.strategies') ?? [];
  if (entries.length === 0) return [{ topic: 'strategies', level: 'warning', message: 'authn.strategies lists no strategy: nothing can authenticate' }];
  const missing = entries.filter((e) => !nearestRegistration(container, AuthenticationStrategy, e.service));
  if (missing.length === 0) return [];
  const names = missing.map((e) => `${q(e.name)} (service ${q(e.service)})`).join(', ');
  return [{ topic: 'strategies', level: 'error', message: `authn.strategies: no AuthenticationStrategy is registered for ${names}; install the package that provides it` }];
}
```
and the head of `checkAuthnConfig`:

```ts
export async function checkAuthnConfig(container: IContainer): Promise<AuthnConfigFinding[]> {
  let config: Configuration;
  try {
    config = (await container.resolve(Configuration)) as Configuration;
  } catch (e) {
    // A configuration the schema refuses never resolves; report each violation (path and rule, never a value).
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => ({ topic: 'schema', level: 'error', message: `${v.path} ${v.message}` }));
    throw e;
  }
  const out: AuthnConfigFinding[] = [];
```
The `legacyFindings` function keeps its `try/catch` (it still guards `config.get`); `safeMessage` is still used by it and by the MFA steps finding.

`registry/named.ts`: delete `readNamedEntries` (lines 16-45 including its doc comment) and the `InvalidOption` import (line 3, unused after). `kindOf`, `q`, `nonEmpty` stay (the registries, `default-authn-service.ts` and `check-config.ts` use them).

- [ ] **Step 5: GREEN + package suite + dependants**

1. `cd packages/authn && npx ts-mocha -p tsconfig.json test/boot/config-defaults.test.ts test/boot/secrets.test.ts test/boot/legacy-keys.test.ts test/boot/check-config.test.ts`
2. `npm test` in `packages/authn`.
3. Rebuild: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.
4. Dependants, sequentially: `authn-http` (the check-config CLI and boot), `users`, then the whole chain once more as a phase check: `authn-local`, `authn-keys`, `authn-token`, `authn-oidc`, `authn-totp`, `authn-orm`.
5. `grep -rn "readNamedEntries\|readThrottleConfig\|readSettings\|readLinking\|readMaxAge\|readForce\|readRoles" packages/authn/src` returns nothing (the audit pilot's `readAuditConfig` is a separate task).

- [ ] **Step 6: Commit**

```bash
git add packages/authn/src/schemas/authn.configuration.ts packages/authn/src/service/boot/secrets.ts packages/authn/src/service/boot/legacy-keys.ts packages/authn/src/service/boot/check-config.ts packages/authn/src/registry/named.ts packages/authn/test/boot/config-defaults.test.ts packages/authn/test/boot/secrets.test.ts packages/authn/test/boot/legacy-keys.test.ts packages/authn/test/boot/check-config.test.ts
git commit -m "refactor(authn): boot checks keep only env and DI rules; shapes and the pepper rules move to the schema"
```

---

## Out of scope for this plan (recorded so they are not lost)

- `packages/authn-totp/src/service/fresh-auth.ts` has its own `readMaxAge` and `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS`; `packages/authn-orm/src/throttle/params.ts` has its own copy of the throttle readers for `DbAuthnThrottle`. Both belong to the phase of their package.
- `authn.session.expiration.maxLifetime` has two readers with the same code default (authn-session and `AuthnImpersonationService`). A shared schema default would need authn-session's `session` block to own it.
- `http.cookie.secret` type check in `secrets.ts` moves with the `http` schema in Phase 3.
- Hot-path cost of `@Config` getters is not a problem for the classes planned here: the throttle snapshots, the others read per request.
