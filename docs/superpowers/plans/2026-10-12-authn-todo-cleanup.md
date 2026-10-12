# authn TODO Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the review TODOs left in `packages/authn/src` (working-tree changes on `authz-v3-refactor`, plus `packages/authn/src/flow/todo.md`): drop hand-rolled infrastructure in favour of `@spinajs/di`, `@spinajs/log`, `@spinajs/util` and `@spinajs/configuration`, remove legacy-key migration code, and document the MFA, fresh-auth, impersonation and linking modules.

**Architecture:** Work runs in five phases, from authn-only removals up to the framework extensions that later authn changes depend on. Every task leaves the tree compiling and green. Phases D and E are scoped here but need their own spec before execution (see "Follow-up plans").

**Tech Stack:** TypeScript ESM, mocha + ts-node/esm (`.mocharc.json` per package), chai, `@spinajs/di`, `@spinajs/configuration` (Ajv 8), `@spinajs/log-common`, `@spinajs/util` (resilience pipeline, TimeSpan).

## Global Constraints

- All code, comments, docs and commit messages are in English. Comments explain only what the code cannot say.
- Breaking changes inside `@spinajs/authn` are allowed. Per the TODOs there is no migration path and no 2.x key mapping.
- Test command (from a package folder): `npx mocha <file>`. Full package: `npx mocha`. Typecheck: `npx tsc -p tsconfig.json --noEmit`.
- Some tests in other packages import built output (`lib/...`), e.g. `authn-totp/test/v3/legacy-keys.test.ts`. Run `npm run build` in `packages/authn` before running them.
- Delete each TODO comment in the same commit that resolves it.
- One commit per task, conventional prefix (`refactor(authn): ...`, `feat(util): ...`, `docs(authn): ...`).

## Scope warning (read first)

The user asked for work on `packages/authn` only. These TODOs reach outside it:

| Needs change in | Why | Tasks |
|---|---|---|
| `packages/util` | shared `isPlainObject`, `isNonEmptyString`, `deepFreeze`, `frozenCopy` | 6 |
| `packages/di` | optional resolve, named lookup across the container lineage | 9, 10 |
| `packages/configuration` | DI-aware lookup for config-listed services (`@AutoinjectService` chain support) | 10 |
| `packages/authn-http`, `authn-totp`, `users` (src + tests) | consumers of removed or renamed authn APIs | 1, 3, 10 |

Phases A and B (tasks 1–8) touch only authn, plus test files in sibling packages and one small util addition. Phases C–E need explicit approval before they start.

## Decisions (recommended default first; the plan assumes the default)

- **D1. Audit sampling.** Remove sampling completely: every `token.use`/`key.use` success is published and `authn.audit.sampleUse` is dropped. *Alternative:* a deterministic 1-in-N counter in a `SamplingAuthnAudit` subclass registered in place of `AuthnAudit`.
- **D2. Sink delivery.** Deliver in parallel (`Promise.allSettled`), each sink bounded by the util `timeoutStrategy`. The code and docs give no reason for serial delivery. The only effect of serial delivery was ordering, and no sink depends on it: each sink writes its own target. Login latency becomes max(sink) instead of sum(sink). The test "awaits each sink before calling the next" gets inverted.
- **D3. One frozen copy.** Deep-freeze one copy of the event and share it across sinks. A frozen `Date` can still be changed with `setTime`, so `frozenCopy` keeps cloning `Date`s. A sink still cannot affect another sink.
- **D4. Logger.** Get the logger with `container.resolve(Log, ['authn-audit'])` inside `resolve()`. Do not use the `@Logger` property decorator: its getter caches one logger per prototype, which defeats the per-test `TestLog`. Drop the `console` fallback that `auditLog()` had. A host without `@spinajs/log` loaded now fails at boot with the DI error instead of logging to stderr.
- **D5. Log line format.** `LogAuthnAuditSink` passes structured fields, `log.info(fields, 'authn audit %s %s', type, outcome)`, and leaves rendering to the log targets. It keeps HMAC hashing of identifiers and the "never write `data`, user agent or `@` values" rule. *Risk:* `enc`/`UNSAFE` escaping currently guards against log-line forging, so Task 7 must confirm that the text log target escapes field values. If it does not, keep `enc` for values until log-common does.
- **D6. "Events instead of audit" (impersonation TODO).** No change. `AuthnEventSink` already is an in-process observer: the DI resolves every registered sink through `Array.chainOf`, and `QueueAuthnEventSink` (users) is just one sink that bridges to the queue. No `EventHandler` exists in the repo. Record this answer in the impersonation README (Task 13).
- **D7. `MINUTE_MS`.** It is a unit factor, not a setting. Replace it with `TimeSpan.fromMinutes(n).totalMilliseconds`. `CLOCK_SKEW_MS` becomes a new schema key `authn.impersonation.clockSkewSeconds` (0–300, default 30). The current comment's claim that it is "the default of `authn.keys.assertion.skewSeconds`" is false, because that key is never read.

---

## Phase A — authn-only removals

### Task 1: Remove legacy-key migration code

**Files:**
- Delete: `packages/authn/src/schemas/legacy-keys.ts`, `packages/authn/src/service/boot/legacy-keys.ts`
- Delete: `packages/authn/test/boot/legacy-keys.test.ts`, `packages/authn-totp/test/v3/legacy-keys.test.ts`
- Modify: `packages/authn/src/schemas/index.ts:2`, `packages/authn/src/service/boot/index.ts:3` (drop re-exports)
- Modify: `packages/authn/src/service/default-authn-service.ts` (import at :30, call at :192, doc at :150-151)
- Modify: `packages/authn/src/service/boot/check-config.ts` (import :13, `legacyFindings` :35-43, call :158, doc :99)
- Modify: `packages/authn/src/service/boot/secrets.ts:11` (drop `'legacy'` from `AuthnConfigFinding.topic`)
- Modify: `packages/authn/src/schemas/authn.configuration.ts:93-99` (drop the whole `config` property; `rejectLegacyKeys` is its only key)
- Modify tests: `authn/test/boot/check-config.test.ts:263-270`, `authn/test/boot/config-defaults.test.ts:99`, `authn/test/contracts/config-schema.test.ts:10,116,182,203,298,508`, `users/test/shipped-config.test.ts:19-28,75-85,104`
- Modify docs: `docs/authn/README.md:141,367,622,636,639`, `packages/authn-totp/README.md:33`, `packages/authz-convert/src/keys.ts:88` (message names `authn.config.rejectLegacyKeys`)

**Interfaces:** Removes the exports `AuthnLegacyKey`, `AUTHN_LEGACY_KEYS`, `AuthnLegacyKeyFinding`, `findAuthnLegacyKeys`, `rejectsAuthnLegacyKeys`, `authnLegacyKeysText` and `checkAuthnLegacyKeys`. The authz host's own legacy keys (`authz/src/host/config/legacy-keys.ts`) are out of scope.

- [ ] **Step 1:** Add a schema test asserting the old key is now rejected or stripped. In `authn/test/contracts/config-schema.test.ts`, validating `{ config: { rejectLegacyKeys: true } }` must leave no `config` property (the configuration Ajv runs `removeAdditional`).
- [ ] **Step 2:** Run `npx mocha test/contracts/config-schema.test.ts` in `packages/authn`. Expected: FAIL, because `config` is still in the schema.
- [ ] **Step 3:** Delete the files and references listed above. Line :508 of `config-schema.test.ts` asserts the schemas folder holds exactly `['authn.configuration.ts','legacy-keys.ts','index.ts']`; change it to `['authn.configuration.ts','index.ts']`.
- [ ] **Step 4:** Run `npx tsc -p tsconfig.json --noEmit && npx mocha` in `packages/authn`, then `npx mocha test/shipped-config.test.ts` in `packages/users`. Expected: all PASS.
- [ ] **Step 5:** Run `grep -rn "rejectLegacyKeys\|AUTHN_LEGACY_KEYS\|checkAuthnLegacyKeys" packages docs --include=*.ts --include=*.md`. Expected: no hits outside `lib/` and `RELEASE_NOTES.md`. Add one line to `RELEASE_NOTES.md`: "authn: 2.x configuration keys are no longer detected; `authn.config` is removed."
- [ ] **Step 6:** Commit `refactor(authn)!: remove 2.x legacy-key detection`.

### Task 2: Drop the `as unknown as Class<>` casts and the `neighbour()` helpers

`Class<T>` is `Abstract<T> | Constructor<T>` (`di/src/types.ts:4-6`), so abstract classes need no cast. The casts exist only because `neighbour()` types its parameter as `abstract new (...args: never[]) => T`. For required services, `container.resolve(T, true)` already throws `Type X is not registered at container` (`di/src/container.ts:315-319`).

**Files:**
- Modify: `packages/authn/src/impersonation/impersonation-service.ts:150-156, 375-381`
- Modify: `packages/authn/src/link/account-link-service.ts:107-111, 192-198`
- Modify: `packages/authn/src/service/default-authn-service.ts:196-200, 598-604`
- Modify: `packages/authn/src/freshauth/fresh-auth-check.ts:36-39`
- Modify: `packages/authn/src/flow/default-mfa-policy.ts:52,75,88,90`, `packages/authn/src/service/boot/check-config.ts:70`
- Test: `packages/authn/test/service/default-authn-service.test.ts:1690`

- [ ] **Step 1:** Update the test at `default-authn-service.test.ts:1690` ("fails boot when a required neighbour is not registered") to expect `/is not registered at container/`. Add the same case to `test/impersonation/*` and `test/link/*` for a missing `SessionIssuer`.
- [ ] **Step 2:** Run `npx mocha test/service/default-authn-service.test.ts`. Expected: FAIL (old message `no SessionIssuer is registered`).
- [ ] **Step 3:** Replace each helper. Required services use the DI check flag. An optional service keeps an inline `hasRegistered` check until Task 9 adds an optional resolve:

```ts
public async resolve(): Promise<void> {
  this.sessions = await this.container.resolve(SessionIssuer, true);
  this.identities = await this.container.resolve(IdentityStore, true);
  this.principals = await this.container.resolve(PrincipalFactory, true);
  this.guard = this.container.hasRegistered(ImpersonationGuard) ? await this.container.resolve(ImpersonationGuard) : undefined;
  this.fresh = await this.container.resolve(FreshAuthCheck);
  this.auditor = await this.container.resolve(AuthnAudit);
  await super.resolve();
}
```

Do the same in `AccountLinkService` (`PasswordCredentialStore` and `KeyRegistry` are optional), `DefaultAuthnService` (`IdentityLinkStore` is optional) and `FreshAuthCheck`. Delete each `neighbour()` method and any `Class` import that is no longer used. If `await` of `ResolveResult<T>` fails to narrow for a non-`AsyncService` type, annotate the field type; do not cast.
- [ ] **Step 4:** Remove the remaining casts in `default-mfa-policy.ts` and `check-config.ts`. Run `grep -rn "as unknown as Class<" packages/authn/src`. Expected: no output.
- [ ] **Step 5:** Run `npx tsc -p tsconfig.json --noEmit && npx mocha`. Expected: PASS.
- [ ] **Step 6:** Commit `refactor(authn): resolve neighbours with plain DI calls`.

The other 51 casts outside authn (authn-http gates, users-http, authn-totp `registered.ts`) are out of scope; list them in the PR description.

### Task 3: Fold `SecretStoringMfaStep` into `MfaStep`

**Files:**
- Modify: `packages/authn/src/contracts/mfa.ts:6`
- Delete: `packages/authn/src/flow/secret-storing-step.ts`; drop its export from `packages/authn/src/flow/index.ts`
- Modify: `packages/authn/src/service/boot/secrets.ts:5,31-35`
- Modify: `packages/authn-totp/src/step/totp-step.ts:43` (keeps `readonly storesSecrets = true`; only check it still compiles)
- Test: `packages/authn/test/boot/secrets.test.ts:245-260`

**Interfaces:** Produces `MfaStep.storesSecrets: boolean` (default `false`). Removes `SecretStoringMfaStep` and `isSecretStoringMfaStep`.

- [ ] **Step 1:** In `secrets.test.ts`, add a case where a step class extends `MfaStep` without declaring `storesSecrets`. `secretStoringSteps()` must not list it. Keep the existing positive case.
- [ ] **Step 2:** Add the member to the contract:

```ts
export abstract class MfaStep {
  abstract readonly name: string;
  /** True when the step keeps secrets (e.g. TOTP seeds); boot then requires `authn.mfa.encryptionKey.secret` outside development and test (A24). */
  readonly storesSecrets: boolean = false;
  // ...existing members unchanged
}
```

- [ ] **Step 3:** In `secrets.ts`, replace the duck-typed filter:

```ts
export async function secretStoringSteps(container: IContainer): Promise<string[]> {
  const steps = (await container.resolve(MfaStepRegistry)).steps();
  return steps.filter((s) => s.storesSecrets).map((s) => s.name);
}
```

- [ ] **Step 4:** Delete `secret-storing-step.ts` and its export. Run `npx tsc --noEmit` in `packages/authn` and `packages/authn-totp`, then `npx mocha test/boot/secrets.test.ts`. Expected: PASS. The test fakes in `test/behaviour/harness.ts:217` and `check-config.test.ts:41` use `defineProperty` and keep working.
- [ ] **Step 5:** Commit `refactor(authn): move storesSecrets onto MfaStep`.

### Task 4: Remove test-only audit constants and fix the impersonation constants

**Files:**
- Modify: `packages/authn/src/audit/config.ts` (delete `DEFAULT_AUDIT_SAMPLE_USE`, `MIN_AUDIT_HASH_KEY_LENGTH`, `DEFAULT_AUDIT_SINK_TIMEOUT_MS`, `MAX_AUDIT_SINK_TIMEOUT_MS`; the schema at `authn.configuration.ts:381-396` is the single source)
- Delete: `packages/authn/test/audit/audit-constants.test.ts`
- Modify: `packages/authn/src/schemas/authn.configuration.ts:371-380` (add `clockSkewSeconds`)
- Modify: `packages/authn/src/config/authn.ts` (add `clockSkewSeconds: 30` under `impersonation`; `config-defaults.test.ts` checks it equals the schema default)
- Modify: `packages/authn/src/impersonation/impersonation-service.ts:55-58, 295, 315, 325`, `ImpersonationConfig` type

- [ ] **Step 1:** In the impersonation tests, add: with `authn.impersonation.clockSkewSeconds: 0`, a block whose `startedAt` lies 1 s in the future is rejected. Add a schema test that `clockSkewSeconds` defaults to 30 and rejects 301.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Add the schema key:

```ts
clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 30 },
```

In the service, replace `MINUTE_MS` with `TimeSpan.fromMinutes(x).totalMilliseconds` (this adds the `@spinajs/util` dependency, same version as the other `@spinajs/*` deps in `packages/authn/package.json`). Replace `CLOCK_SKEW_MS` with `this.Config.clockSkewSeconds * 1000`, read through the existing `@Config('authn.impersonation')` object. Delete both constants and the TODO.
- [ ] **Step 4:** Remove the deleted audit constants from `authn-audit.ts:8,49`. The field gets its value in `resolve()`, so declare it without an initialiser.
- [ ] **Step 5:** Run `npx tsc --noEmit && npx mocha`. Expected: PASS.
- [ ] **Step 6:** Commit `refactor(authn): make impersonation clock skew configurable, drop test-only constants`.

---

## Phase B — shared helpers, logging, audit pipeline

### Task 5: Fix `iso()` type checking in the log sink

**Files:** Modify `packages/authn/src/audit/log-sink.ts:34-40`; Test `packages/authn/test/audit/log-sink.test.ts`.

- [ ] **Step 1:** Add tests: `at: new Date(NaN)` writes `at=?`; `at: 'x'` writes `at=?`; a valid date writes its ISO string.
- [ ] **Step 2:** Replace the helper:

```ts
const iso = (d: unknown): string => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : '?');
```

- [ ] **Step 3:** Run `npx mocha test/audit/log-sink.test.ts`. Expected: PASS. Commit `fix(authn): check the event date type instead of catching`.

(Task 7 may later absorb this helper; doing it first keeps that task smaller.)

### Task 6: Shared guards and freezing in `@spinajs/util`; dedupe authn helpers

**Files:**
- Create: `packages/util/src/object.ts`; export it from `packages/util/src/index.ts`
- Modify: `packages/util/src/types.ts` (add `isNonEmptyString`)
- Test: `packages/util/test/object.test.ts`, `packages/util/test/util.test.ts`
- Create: `packages/authn/src/support/guards.ts` (authn-specific `isRef`, `errorClass`)
- Modify: `throttle/select.ts:9`, `service/default-authn-service.ts:80-97`, `service/boot/legacy-keys.ts` (already deleted in Task 1), `link/account-link-service.ts:38-44`, `impersonation/impersonation-service.ts:64-74`, `registry/named.ts:13`, `freshauth/fresh-auth-check.ts:48`, `impersonation/active-role.ts:11`, `throttle/memory-throttle.ts:64` (`deepFreeze`), `audit/authn-audit.ts:26-34` (`frozenCopy`)

**Interfaces (produced, from `@spinajs/util`):**

```ts
export function isPlainObject(v: unknown): v is Record<string, unknown>; // non-null object, not an array
export function isNonEmptyString(v: unknown): v is string;
export function deepFreeze<T>(v: T): Readonly<T>;                       // freezes in place, returns v
export function frozenCopy<T>(v: T, maxDepth?: number): Readonly<T>;    // clone + freeze, Dates cloned, undefined past maxDepth (default 16)
```

lodash is not used: it is not a direct dependency of authn or util, and `_.isPlainObject` rejects class instances, which the current checks accept.

- [ ] **Step 1:** Write `packages/util/test/object.test.ts`:

```ts
import { expect } from 'chai';
import { isPlainObject, deepFreeze, frozenCopy, isNonEmptyString } from '../src/index.js';

describe('object helpers', () => {
  it('isPlainObject accepts objects, rejects null and arrays', () => {
    expect(isPlainObject({})).to.be.true;
    expect(isPlainObject(null)).to.be.false;
    expect(isPlainObject([])).to.be.false;
    expect(isPlainObject('x')).to.be.false;
  });
  it('isNonEmptyString', () => {
    expect(isNonEmptyString('a')).to.be.true;
    expect(isNonEmptyString('')).to.be.false;
    expect(isNonEmptyString(1)).to.be.false;
  });
  it('deepFreeze freezes nested values in place', () => {
    const v = { a: { b: [1] } };
    expect(deepFreeze(v)).to.equal(v);
    expect(Object.isFrozen(v.a.b)).to.be.true;
  });
  it('frozenCopy clones dates and leaves the source mutable', () => {
    const at = new Date(0);
    const src = { at, list: [{ x: 1 }] };
    const out = frozenCopy(src);
    expect(out).to.not.equal(src);
    expect(out.at).to.not.equal(at);
    expect(out.at.getTime()).to.equal(0);
    expect(Object.isFrozen(out.list[0])).to.be.true;
    expect(Object.isFrozen(src)).to.be.false;
  });
  it('frozenCopy cuts values deeper than maxDepth', () => {
    expect(frozenCopy({ a: { b: 1 } }, 0)).to.deep.equal({ a: undefined });
  });
});
```

- [ ] **Step 2:** Run `npx mocha test/object.test.ts` in `packages/util`. Expected: FAIL (exports missing).
- [ ] **Step 3:** Implement `object.ts`. Port `frozenCopy` verbatim from `authn-audit.ts:26-34`, with `maxDepth` as a parameter. `deepFreeze` recurses over `Object.values` of objects and arrays that are not yet frozen. Add `isNonEmptyString` to `types.ts`.
- [ ] **Step 4:** Run `npx mocha` in `packages/util`. Expected: PASS. Commit `feat(util): add isPlainObject, isNonEmptyString, deepFreeze, frozenCopy`.
- [ ] **Step 5:** In authn, delete the five `isObject`, four `nonEmpty` and local `deepFreeze`/`frozenCopy` copies and import from `@spinajs/util`. Move the two `isRef` and three `errorClass` copies into `src/support/guards.ts`. Replace the inline checks in `fresh-auth-check.ts:48` and `active-role.ts:11` with `isNonEmptyString`.
- [ ] **Step 6:** Run `grep -rnE "const (isObject|nonEmpty|isRef|errorClass) =|function (deepFreeze|frozenCopy)" packages/authn/src`. Expected: only `support/guards.ts`. Then run `npx tsc --noEmit && npx mocha` in `packages/authn`. Expected: PASS.
- [ ] **Step 7:** Commit `refactor(authn): use util guards, dedupe local helpers`.

The roughly 40 copies in authz*, authn-* and telemetry are out of scope; list them in the PR as follow-up.

### Task 7: Replace `AuditLog` with `@spinajs/log`

**Files:**
- Delete: `packages/authn/src/audit/log.ts`, `packages/authn/src/service/boot/log.ts`
- Modify: `packages/authn/src/audit/log-sink.ts`, `packages/authn/src/audit/authn-audit.ts`, `packages/authn/src/service/default-authn-service.ts:31,191-193,207` (`warnOnce`)
- Modify: `packages/authn/src/throttle/memory-throttle.ts:221-232` (`reportFull` has its own `DI.check(Log)` + console fallback)
- Test: `packages/authn/test/audit/log-sink.test.ts`, `log-sink-hashing.test.ts`, `authn-audit.test.ts` (use `test/audit/test-log.ts`'s `TestLog` registered as `Log` instead of overwriting `(sink as any).out` or passing `options.log`)

**Interfaces:** Removes `AuditLog`, `auditLog`, `AuthnAuditOptions.log` and `warnOnce`.

- [ ] **Step 1 (verification for D5):** Read the text and console targets in `packages/log/src/targets/*`. Check whether field values pass through `safeStringify` (`log-common/src/serializers.ts`) and whether control characters and U+2028/U+2029 come out escaped. Record the result in the task's PR note.
  - If they are escaped: the sink passes structured fields.
  - If not: the sink keeps `enc()` for values and passes a pre-built message. In both cases the hashing and the `@`-drop rule stay in the sink.
- [ ] **Step 2:** Rewrite the tests to register `TestLog` as `Log` in the child container and assert on its captured entries (level, message, fields), not on overwritten fields. Delete the `auditLog(name, resolveLog)` tests (`log-sink.test.ts:245-270`). Run: FAIL.
- [ ] **Step 3:** The sink resolves its logger once:

```ts
@PerChildInstance()
@Injectable(AuthnEventSink)
@Inject(Container)
export class LogAuthnAuditSink extends AuthnEventSink {
  @Config('authn.audit')
  protected Config: AuditConfig;

  private log: Log;

  constructor(private readonly container: IContainer) {
    super();
  }

  async publish(e: AuthnEvent): Promise<void> {
    this.log ??= this.container.resolve(Log, ['authn-audit'], true);
    const fields = this.fields(e);
    if (e.outcome === 'failure') this.log.warn(fields, 'authn audit %s %s', e.type, e.outcome);
    else this.log.info(fields, 'authn audit %s %s', e.type, e.outcome);
  }
  // fields(): at, strategy, reason, identity, actor, ip, session — same selection, hashing and @-drop as today
}
```

If `AuthnEventSink` is a plain abstract class (not a service), the `@Inject(Container)` constructor is fine. Otherwise keep property access through `DI` and note it.
- [ ] **Step 4:** `AuthnAudit` resolves the logger in `resolve()` with `this.container.resolve(Log, ['authn-audit'], true)` (D4), and the `options.log` constructor parameter goes away. `DefaultAuthnService` gets a `Log` named `'authn-boot'` the same way. Its once-only dedupe stays as a private `Set<string>` on the service, because `Log` has no once-only API.
- [ ] **Step 5:** `memory-throttle.ts` `reportFull` uses `DI.resolve(Log, ['authn-throttle'])`.
- [ ] **Step 6:** Run `grep -rn "auditLog\|AuditLog\|warnOnce" packages/authn/src packages/authn-orm/src`. Expected: none in authn. `authn-orm/src/throttle/db-throttle.ts:446-463` has its own copy and stays out of scope; note it. Then run `npx tsc --noEmit && npx mocha` in `packages/authn`. Expected: PASS.
- [ ] **Step 7:** Commit `refactor(authn): log through @spinajs/log`.

### Task 8: Audit pipeline — no sampling, parallel sinks, util timeout, `Resolved` flag

**Files:**
- Modify: `packages/authn/src/audit/authn-audit.ts`, `packages/authn/src/audit/config.ts` (drop `sampleUse`)
- Modify: `packages/authn/src/schemas/authn.configuration.ts:381-396`, `packages/authn/src/config/authn.ts:36-40` (drop `sampleUse`)
- Test: `packages/authn/test/audit/authn-audit.test.ts` (delete the `sampling` block :349-389; invert :215-221; keep the timeout, late-rejection and frozen-copy tests), `default-authn-service.test.ts:1092` (drop `sampleUse: 1`)
- Docs: `docs/authn/README.md:508-530` (sinks run concurrently; no sampling), `docs/authz/migration-guide.md:1148`, `docs/auth-feat/10-outbound-webhooks.md:28,36`

- [ ] **Step 1:** Write the new tests:

```ts
it('delivers to all sinks concurrently', async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  class A extends AuthnEventSink { async publish() { started.push('a'); await gate; } }
  class B extends AuthnEventSink { async publish() { started.push('b'); } }
  const audit = await boot([A, B]);
  const done = audit.publish(event('login'));
  await Promise.resolve();
  expect(started).to.have.members(['a', 'b']);
  release();
  await done;
});

it('publishes every successful token.use', async () => {
  const sink = new Recording();
  const audit = await boot([sink]);
  for (let i = 0; i < 5; i++) await audit.publish(event('token.use', 'success'));
  expect(sink.events).to.have.length(5);
});

it('throws when publishing before resolve', async () => {
  const audit = new AuthnAudit(DI.child());
  await expect(audit.publish(event('login'))).to.be.rejectedWith(InvalidOperation, /not resolved/);
});
```

`boot`, `event` and `Recording` are the existing helpers in this test file; adapt their names to those found at :160-167 and :91.
- [ ] **Step 2:** Run `npx mocha test/audit/authn-audit.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement:

```ts
@PerChildInstance()
@Inject(Container)
export class AuthnAudit extends AsyncService {
  @Config('authn.audit')
  protected Config: AuditConfig;

  private all: readonly AuthnEventSink[] = [];
  private pipeline: ResiliencePipeline<void>;
  private log: Log;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    const config = this.Config;
    if (!config) throw new InvalidOperation('authn.audit is unset: AUTHN_CONFIGURATION_SCHEMA is not registered');
    this.log = this.container.resolve(Log, ['authn-audit'], true);
    // A child that registers its own sink keeps its ancestors' ones; each is built where it was registered.
    const sinks = await this.container.resolve(Array.chainOf(AuthnEventSink));
    if (sinks.length === 0) this.log.warn('AuthnAudit: no AuthnEventSink is registered; authentication events are not audited');
    this.pipeline = new ResiliencePipelineBuilder<void>().addTimeout(TimeSpan.fromMilliseconds(config.sinkTimeoutMs)).build();
    this.all = Object.freeze([...sinks]);
    await super.resolve();
  }

  public sinks(): readonly AuthnEventSink[] {
    this.assertResolved();
    return this.all;
  }

  /** Never rejects because of a sink. */
  public async publish(e: AuthnEvent): Promise<void> {
    this.assertResolved();
    const event = frozenCopy(e);
    await Promise.allSettled(this.all.map((sink) => this.deliver(sink, event)));
  }

  // Logs the error class only: a sink's error message can echo event values.
  private async deliver(sink: AuthnEventSink, event: AuthnEvent): Promise<void> {
    const name = sink.constructor.name;
    try {
      await this.pipeline.execute(() => Promise.resolve().then(() => sink.publish(event)));
    } catch (err) {
      if (err instanceof TimeoutRejectedException) this.log.warn(`AuthnAudit: sink ${q(name)} timed out on a ${q(event.type)} event after ${this.Config.sinkTimeoutMs} ms`);
      else this.log.warn(`AuthnAudit: sink ${q(name)} failed to publish a ${q(event.type)} event (${errorClass(err)})`);
    }
  }

  private assertResolved(): void {
    if (!this.Resolved) throw new InvalidOperation('AuthnAudit is not resolved');
  }
}
```

`Promise.race` inside `timeoutStrategy` attaches a handler to the sink promise, so a sink that rejects after its timeout does not cause an unhandled rejection. The existing test at :265-282 must still pass.
- [ ] **Step 4:** Remove `sampleUse` from the schema, the default config, `AuditConfig` and `SAMPLED`. Removing it from the schema makes Ajv strip the key from existing configs (`removeAdditional`), so no boot failure follows.
- [ ] **Step 5:** Run `npx tsc --noEmit && npx mocha` in `packages/authn`. Expected: PASS. Run `npx mocha` in `packages/users` (`QueueAuthnEventSink`, `UserAccountSink`) and `packages/authn-orm` (`DbAuthnAuditSink`). Expected: PASS.
- [ ] **Step 6:** Update the three docs, then commit `refactor(authn)!: deliver audit events to all sinks concurrently, drop sampling`.

---

## Phase C — DI extensions (needs approval: touches `packages/di`, `packages/configuration`)

### Task 9: Optional resolve in `@spinajs/di`

**Files:** Modify `packages/di/src/interfaces.ts:96-138`, `packages/di/src/container.ts`; Test `packages/di/test/*.test.ts`; then use it in the authn files touched by Task 2.

**Interfaces (produced):**

```ts
// IContainer
resolveOptional<T>(type: Class<T> | string, options?: unknown[]): ResolveResult<T> | undefined;
```

It returns `undefined` when `hasRegistered(type)` is false (walking parents). Unlike a plain `resolve`, it never instantiates the abstract class as a fallback and never leaves the "implicit" registry key behind (`registry.ts:11-14`).

- [ ] **Step 1:** Write the di tests: an unregistered abstract class returns `undefined` and `hasRegistered` stays false afterwards; a class registered in the parent resolves from a child; a registered `AsyncService` is resolved (await yields an instance).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement it in `Container` as `return this.hasRegistered(type) ? this.resolve(type, options) : undefined;` and add it to `IContainer`.
- [ ] **Step 4:** Run `npx mocha` in `packages/di`. Expected: PASS. Commit `feat(di): add resolveOptional`.
- [ ] **Step 5:** In authn, replace the inline `hasRegistered ? resolve : undefined` from Task 2 with `await this.container.resolveOptional(X)`. Run the authn tests, then commit `refactor(authn): use resolveOptional`.

### Task 10: Named, lineage-aware lookup in DI; replace `registry/named.ts` and `MfaStepRegistry`

This task is large. Before execution, spend a short design pass on whether to extend `@AutoinjectService` (`configuration/src/decorators.ts:160-210`) or add container methods. The recommended shape:

**Interfaces (produced, `@spinajs/di`):**

```ts
// IContainer
/** Names of the registrations of `base` across the lineage, nearest container last, no repeats. */
getRegisteredNames(base: Class<unknown>): string[];
/** The registration of `base` named `name`, nearest container first; a factory is called with this container, a class resolves through DI. Undefined when none. */
resolveNamed<T>(base: Class<T>, name: string): Promise<T | undefined>;
```

**Interfaces (produced, `@spinajs/configuration`):**
- `@AutoinjectService(path, Type, { lineage: true, keyBy: 'name' })` injects `Map<string, T>`:
  - lookup goes through `resolveNamed` (nearest wins);
  - the map is keyed by the config entry's `name`;
  - entries keep config order;
  - an unknown service throws `ServiceNotFound`;
  - an entry whose `name` differs from the instance's `name` throws `InvalidOption` (today's `MfaStepRegistry` check).

**Consumers to migrate:**
- authn: `registry/strategy-registry.ts:76-89`, `flow/mfa-step-registry.ts`, `default-authn-service.ts:607-617` (`selectPolicy`), `throttle/select.ts:15-36`, `service/boot/check-config.ts:29,67`, `service/boot/secrets.ts:33`, `flow/default-mfa-policy.ts:60`
- authn-http: `mfa/gate.ts:31`, `policies/v3/mfa.ts:79`, `v3/controllers/AuthnMfaEnrolmentController.ts:53`
- tests: `authn/test/flow/mfa.test.ts:86-147`, `authn-http/test/v3/authn-policies.test.ts:373`, `authn-http/test/v3-app/behaviour/{harness,n8b-harness}.ts`, `users/test/support/http-app.ts:121`

Steps:
- [ ] **Step 1:** Write the di tests for `getRegisteredNames` and `resolveNamed`, porting the cases from authn's registry tests: a factory named via `Object.defineProperty`, a child overriding a parent registration with the same name, and an unknown name returning `undefined`. Implement them by moving the logic from `authn/src/registry/named.ts`. Run `npx mocha` in `packages/di`. Commit `feat(di): add named lookup across the container lineage`.
- [ ] **Step 2:** Extend `@AutoinjectService` with `lineage` and `keyBy`, test it in `packages/configuration/test`, and commit `feat(configuration): lineage-aware AutoinjectService`.
- [ ] **Step 3:** In authn, replace `MfaStepRegistry` with the injected property `@AutoinjectService('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' }) protected MfaSteps: Map<string, MfaStep>` on each consumer. Keep `RECOVERY_STEP` exported from `flow/index.ts`. Delete `mfa-step-registry.ts`.
- [ ] **Step 4:** Migrate `StrategyRegistry`, `selectPolicy` and `selectAuthnThrottle` to `resolveNamed`/`getRegisteredNames`, then delete `registry/named.ts`.
- [ ] **Step 5:** Run the full tests in authn, authn-http and users. Commit `refactor(authn)!: resolve MFA steps and strategies through DI`.

---

## Follow-up plans (scoped, not executable from this document)

### Phase D — Replace manual config checks with schema validation

This covers the TODOs in `service/boot/check-config.ts` and `service/boot/env.ts`. It needs its own spec because `@spinajs/configuration` builds its own Ajv (`configuration.ts:509-557`) with no keyword or DI hook, and validation runs before most services are registered. How each current check would move:

| Check | Target |
|---|---|
| empty `authn.strategies`, throttle param ranges (`env.ts:75-91` duplicates the schema) | plain schema (`minItems`); delete the duplicates |
| `http.cors.origins`, `http.cookie.secret` type | the http module's schema, not authn's |
| strategy / throttle / MFA step service registered | new configuration extension point: custom Ajv keyword such as `x-registered: 'AuthenticationStrategy'`, checked after DI registration (needs a second validation pass at `DefaultAuthnService.resolve`) |
| cookie secret public or missing outside dev/test; MFA encryption key with secret-storing steps | env-specific config files (`authn.prod.js`) cannot express "not the public default"; needs a schema `not: { const: PUBLIC }` applied per environment, or the check stays in code |
| `authnEnvFellBack` re-deriving APP_ENV | fix the `normalizeEnvironment` (unset → `production`) vs `Configuration.load` (unset → `development`) mismatch in configuration-common, then delete |
| `enrolmentFindings` (DB data), `trustProxy` cross-module warning | runtime data, so it stays in the CLI `authn:check-config`, not in the schema |

### Phase E — Move generic throttle code to `@spinajs/util`

This covers the TODO in `throttle/memory-throttle.ts`. The generic part is a keyed row table with `maxRows` eviction, sweep batches and frozen snapshots. The authn part is HMAC-keyed rows, `ThrottleFlow`, `backoffDelayMs` and `checkThrottleParams`. The plan is to extract a `KeyedBackoffTable<Row>` into util and keep `MemoryAuthnThrottle` as a thin adapter. `DbAuthnThrottle` (authn-orm) shares the row logic and should use the same core. The existing util `concurrencyLimiter` and http `ThrottleMiddleware` do not fit this use.

---

## Phase F — Documentation (run after phases A–C so docs match the final API)

Each README follows the style of `packages/authn-token/README.md`: a title, a short intro, "What it provides" bullets, then prose sections. Each is linked from `docs/authn/README.md` and the package README.

### Task 11: `packages/authn/src/flow/README.md` — MFA flow and step lookup

This replaces `flow/todo.md`, which is deleted in the same commit. Sections:

1. **Entry points:**
   - `AuthnService.authenticate()` returns `{ status: 'mfa_required', pending, steps }` (`credentials.ts:65`).
   - `AuthnService.completeMfa(pending, step, response, ctx)` (`default-authn-service.ts:257`).
   - `MfaStep` contract (`contracts/mfa.ts`) and `MfaPolicy` with `DefaultMfaPolicy`.
   - `MfaEnrolments`.
   - HTTP routes: `AuthnMfaController` (POST `auth/mfa/verify`, `auth/mfa/recovery`) and `AuthnMfaEnrolmentController` (`user/mfa`, `mfa/confirm`, `mfa/disable`, `mfa/recovery-codes`).
2. **Registering a step:** `@Injectable(MfaStep)`, the `authn.mfa.steps` entry `{ name, service }`, the name-match rule, and `storesSecrets` with `authn.mfa.encryptionKey.secret` (A24).
3. **Example, one step:** TOTP login, as a code sample with `authenticate` followed by `completeMfa`.
4. **Example, several steps:** the policy returns several names, any one of them passes, and the recovery path uses `RECOVERY_STEP`.
5. **Verification and errors:**
   - throttling under flow `'mfa'`;
   - one-time codes;
   - `MfaStepNotListed` and `MfaEnrolmentMismatch` with their `is*` helpers;
   - boot-time `InvalidOption`;
   - session elevation to aal2.

- [ ] Write the file. Check every code sample by copying it into a scratch test under `test/flow/readme-examples.test.ts` and running it. Delete `todo.md`. Commit `docs(authn): MFA flow README`.

### Task 12: `packages/authn/src/freshauth/README.md`

Sections:
- entry points: `FreshAuthCheck.check(session, ctx, reauth?)`, `maxAgeSeconds`, `isFresh` (`contracts/fresh.ts:8`), and the HTTP `FreshAuth` policy (`authn-http/src/policies/v3/fresh-auth.ts:71`);
- DI registration (`@PerChildInstance`, its required neighbours);
- configuration `authn.freshAuth.*`;
- flow: an impersonated or inactive session returns false; a fresh session returns true; otherwise `reauthenticate`.

- [ ] Write the file. Remove the TODO from `freshauth/index.ts`. Commit `docs(authn): fresh-auth README`.

### Task 13: `packages/authn/src/impersonation/README.md`

Sections:
- entry points: `start`, `stop`, `principalOf`, `endFor`, `IMPERSONATION_BLOCK`, `ImpersonationGuard` (implemented by `AuthzImpersonationGuard` in users);
- DI registration and required neighbours;
- flow:
  - the session data block `{ startedAt, actorRoles? }`;
  - the active-role ceiling;
  - `maxMinutes` expiry and `clockSkewSeconds` from Task 4;
  - session states;
  - audit events `impersonation.start/end/expire`;
- HTTP: `AuthnImpersonationController` (GET, POST and DELETE `auth/impersonate`) and `AuthnActiveRoleController`;
- programmatic use;
- "Why audit sinks, not a separate event bus" (D6).

- [ ] Write the file. Remove the TODO at `impersonation-service.ts:20`. Commit `docs(authn): impersonation README`.

### Task 14: `packages/authn/src/link/README.md`

Sections:
- entry points: `AccountLinkService.link`/`unlink`, `LinkResult`, refusal reasons (`not_active`, `invalid_subject`, `store_error`, `unknown_link`, `last_credential`), `IdentityLinkStore`, `linkingSwitchesOf`;
- DI registration;
- flow: the session requirement, fresh-auth/reauth, and the last-credential guard;
- HTTP exposure through authn-oidc (`OidcController` POST/DELETE `:provider/link`);
- configuration `authn.linking.*`.

- [ ] Write the file. Remove the TODO. Commit `docs(authn): account-linking README`.

---

## TODO → task map

| TODO location | Task |
|---|---|
| audit/authn-audit.ts: logger | 7 |
| audit/authn-audit.ts: sampling, randomness | 8 (D1) |
| audit/authn-audit.ts: parallel delivery | 8 (D2) |
| audit/authn-audit.ts: frozenCopy to util | 6 |
| audit/authn-audit.ts: resilience timeout | 8 |
| audit/authn-audit.ts: Resolved flag | 8 |
| audit/config.ts constants | 4 |
| audit/log-sink.ts (common code, iso, format, logger) | 5, 7 |
| audit/log.ts | 7 |
| flow/mfa-step-registry.ts | 10 |
| flow/secret-storing-step.ts | 3 |
| flow/todo.md | 11 |
| freshauth/fresh-auth-check.ts casts, emptiness | 2, 6 |
| freshauth/index.ts README | 12 |
| impersonation README, constants, duplicates, events, neighbour | 13, 4, 6, D6, 2/9 |
| link README, duplicates, neighbour | 14, 6, 2/9 |
| registry/named.ts | 10 |
| schemas/legacy-keys.ts, boot/legacy-keys.ts | 1 |
| boot/check-config.ts, boot/env.ts | Phase D |
| boot/log.ts | 7 |
| throttle/memory-throttle.ts | Phase E (`deepFreeze` part in 6, logger in 7) |
