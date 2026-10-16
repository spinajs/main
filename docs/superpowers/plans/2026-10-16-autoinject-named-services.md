# `@AutoinjectNamedServices` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `resolveNamedServices(container, path, type, options)` into a property decorator, `@AutoinjectNamedServices(path, type, options)`, and use it for the MFA step list in `ConfiguredMfaPolicy`.

**Architecture:** DI gets back the `IToInject.resolveFunc` hook (removed as unused in `c31831f42`): a property dependency that builds its own value from `data` and the resolving container, possibly as a promise. `@spinajs/configuration` adds a decorator next to `AutoinjectService` that pushes a `resolveFunc` calling `resolveNamedServices`. `ConfiguredMfaPolicy` (authn `src/flow/default-mfa-policy.ts`) drops its hand-written listing and caching for the decorated property.

**Tech Stack:** TypeScript (mjs + cjs builds), `@spinajs/di`, `@spinajs/configuration`, mocha + chai via `ts-mocha`.

## Global Constraints

- English for code, comments, docs and commit messages. Comment only what the code cannot say.
- `@spinajs/authn/contracts` may import only `@spinajs/di` (`packages/authn/test/contracts/boundary.test.ts`, `ALLOWED_PACKAGES`). The decorator is used in `src/flow`, never in `src/contracts`.
- `resolveNamedServices` keeps its signature and messages. Tests match them exactly, e.g. `flow.steps entry "totp": no Step is registered as service "TotpStep"` and `authn.mfa.steps lists name "fake" twice`.
- `AutoinjectService` keeps its current behaviour (Map by `ServiceName`, warning on an empty value). The new decorator is a separate function, not an overload.
- After changing code, run `graphify update .` from the repo root.

## Decisions

- **A separate decorator, not an `AutoinjectService` overload.** The two inject different things: `AutoinjectService` returns a Map keyed by `ServiceName`, takes the first container's registrations and warns on an empty value. The new one returns a Map keyed by the entry's `keyBy`, looks up the lineage, validates every entry, and gives an empty Map for an unset path. One name per behaviour keeps both readable. The overload was tried in `e50bc0c5d` and removed in `c31831f42`.
- **The DI hook is `resolveFunc`**, restored exactly as `c31831f42` removed it. `serviceFunc` can't express this: it names registrations for DI to resolve, but it can't validate the instances or key the Map by entry.
- **The duck-typed "is an MfaStep" check stays in `ConfiguredMfaPolicy.resolve()`.** It's MFA-specific, so it doesn't belong in a generic decorator option.
- **Out of scope:** `StrategyRegistry`. It reads `authn.strategies` with `@Config` and validates entries with its own messages (`no AuthenticationStrategy is registered as service …` as `InvalidOption`, plus interactive and kinds checks). Moving it would change its errors and tests. Possible follow-up.

## Prerequisite

The uncommitted refactor on `feat/authz-v3` must be green first:
- `mfa-steps.ts` removed
- `MfaPolicy.steps()` added
- `ConfiguredMfaPolicy` added
- authn-http and fakes updated

authn passes (898). Still to run: authn-testing, users and authn-http. Commit that work before Task 1, so this plan's commits stay separate.

## File Structure

| File | Change |
| --- | --- |
| `packages/di/src/interfaces.ts` | `IToInject.resolveFunc?` |
| `packages/di/src/container.ts` | `resolveDependencies` honours `resolveFunc` first |
| `packages/di/test/resolve-func.test.ts` | Create: the hook's tests |
| `packages/configuration/src/decorators.ts` | `AutoinjectNamedServices` |
| `packages/configuration/test/autoinject-lineage.test.ts` | Decorator tests beside the `resolveNamedServices` ones |
| `packages/authn/src/flow/default-mfa-policy.ts` | `ConfiguredMfaPolicy` uses the decorator; `DefaultMfaPolicy` autoinjects its own `Container` |
| `packages/authn/src/flow/README.md` | One paragraph on where the list comes from |
| `RELEASE_NOTES.md` | DI and Configuration lines |

---

### Task 1: DI `resolveFunc` hook

**Files:**
- Modify: `packages/di/src/interfaces.ts` (interface `IToInject`, after `mapFunc` near line 199)
- Modify: `packages/di/src/container.ts` (`resolveDependencies`, near line 695)
- Create: `packages/di/test/resolve-func.test.ts`
- Modify: `RELEASE_NOTES.md` (section `### DI (`@spinajs/di`)`)

**Interfaces:**
- Produces: `IToInject<T>.resolveFunc?: (data: any, container: IContainer) => unknown`. When set, the container injects its return value (awaited if it's a promise) under `autoinjectKey`, and `inject`, `serviceFunc` and `mapFunc` are not used.

- [ ] **Step 1: Write the failing test**

`packages/di/test/resolve-func.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { AddDependencyForProperty, DI } from '../src/index.js';
import type { IContainer, IInjectDescriptor } from '../src/index.js';

function Computed(make: (data: unknown, container: IContainer) => unknown, data?: unknown) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target, propertyKey) => {
    descriptor.inject.push({ autoinject: true, autoinjectKey: propertyKey, inject: Object, data, resolveFunc: make });
  });
}

const seen: IContainer[] = [];

class SyncHolder {
  @Computed((data, c) => {
    seen.push(c);
    return `value of ${String(data)}`;
  }, 'key')
  public Value: string;
}

class AsyncHolder {
  @Computed(async () => new Map([['a', 1]]))
  public Value: Map<string, number>;
}

class FailingHolder {
  @Computed(async () => {
    throw new Error('no value');
  })
  public Value: unknown;
}

describe('a property dependency with resolveFunc', () => {
  beforeEach(() => {
    DI.clear();
    seen.length = 0;
  });

  it('injects what resolveFunc returns, given the data and the resolving container', () => {
    const child = DI.child();
    const holder = child.resolve(SyncHolder);
    expect(holder.Value).to.equal('value of key');
    expect(seen).to.deep.equal([child]);
  });

  it('waits for a promise resolveFunc returns', async () => {
    const holder = await (DI.resolve(AsyncHolder) as unknown as Promise<AsyncHolder>);
    expect([...holder.Value]).to.deep.equal([['a', 1]]);
  });

  it('rejects the resolve when resolveFunc rejects', async () => {
    const error = await (DI.resolve(FailingHolder) as unknown as Promise<FailingHolder>).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).to.equal('no value');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd packages/di && npx ts-mocha -p tsconfig.json test/resolve-func.test.ts`
Expected: the tsc diagnostic `Object literal may only specify known properties, and 'resolveFunc' does not exist in type 'IToInject<unknown>'`.

- [ ] **Step 3: Add the field**

In `packages/di/src/interfaces.ts`, inside `IToInject<T>`, after `mapFunc?: (x: any) => string | undefined;`:

```ts
  /**
   * Builds the injected value itself, from `data` and the resolving container; it may return a promise.
   * When set, `inject`, `serviceFunc` and `mapFunc` are not used to resolve it.
   */
  resolveFunc?: (data: any, container: IContainer) => unknown;
```

- [ ] **Step 4: Honour it in the container**

In `packages/di/src/container.ts`, at the top of the `toInject.map((t) => { … })` callback in `resolveDependencies`, before `let tInject = null;`:

```ts
      if (t.resolveFunc) {
        const injected = (instance: unknown) => ({ autoinject: t.autoinject, autoinjectKey: t.autoinjectKey, instance });
        const value = t.resolveFunc(t.data, this);
        return isPromise(value) ? value.then(injected) : injected(value);
      }
```

`isPromise` is already imported from `./helpers.js`.

- [ ] **Step 5: Run the test and the DI suite**

Run: `cd packages/di && npx ts-mocha -p tsconfig.json test/resolve-func.test.ts`
Expected: 3 passing.

Run: `cd packages/di && npm test`
Expected: no failures.

- [ ] **Step 6: Release note**

In `RELEASE_NOTES.md`, under `### DI (`@spinajs/di`)`, add a bullet after the `Array.chainOf(X)` one:

```markdown
- `IToInject.resolveFunc` lets a property dependency build its own value from its `data` and the
  resolving container; a promise is awaited. `@AutoinjectNamedServices` is built on it.
```

- [ ] **Step 7: Commit**

```bash
git add packages/di/src/interfaces.ts packages/di/src/container.ts packages/di/test/resolve-func.test.ts RELEASE_NOTES.md
git commit -m "feat(di): resolveFunc builds a property dependency from its data and the resolving container"
```

---

### Task 2: `@AutoinjectNamedServices` decorator

**Files:**
- Modify: `packages/configuration/src/decorators.ts` (after `resolveNamedServices`, before `AutoinjectService`)
- Modify: `packages/configuration/test/autoinject-lineage.test.ts`
- Modify: `RELEASE_NOTES.md` (section `### Configuration and util`)

**Interfaces:**
- Consumes: `IToInject.resolveFunc` (Task 1); `resolveNamedServices<T>(container: IContainer, path: string, type: Class<T>, options: IAutoinjectServiceOptions): Promise<Map<string, T>>`; `IAutoinjectServiceOptions { lineage: true; keyBy: string }`. All three already exist.
- Produces: `export function AutoinjectNamedServices<T>(path: string, type: Class<T>, options: IAutoinjectServiceOptions): PropertyDecorator`-shaped decorator. The decorated property receives exactly what `resolveNamedServices(resolvingContainer, path, type, options)` returns. Any error it throws rejects the resolve of the owning class.

- [ ] **Step 1: Write the failing tests**

In `packages/configuration/test/autoinject-lineage.test.ts`:

Change the imports:

```ts
import { DI, IContainer, PerChildInstance, ServiceNotFound } from '@spinajs/di';
```

```ts
import { AutoinjectNamedServices, resolveNamedServices } from '../src/decorators.js';
```

After `function factory(…) { … }`, add:

```ts
@PerChildInstance()
class Flow {
  @AutoinjectNamedServices('flow.steps', Step, { lineage: true, keyBy: 'name' })
  public Steps: Map<string, Step>;
}
```

In `beforeEach`, after `root.register(RootStep).as(Step);`:

```ts
    root.register(Flow).asSelf();
```

At the end of the file, add a second `describe` that reuses the same fixtures. Move `containers`, `child`, `root`, `beforeEach` and `afterEach` up from inside `describe('resolveNamedServices', …)` to module level, so both describes share them. Leave the existing tests unchanged.

```ts
describe('@AutoinjectNamedServices', () => {
  const flowOf = async (c: IContainer) => {
    await c.resolve(Configuration);
    return (await (c.resolve(Flow) as unknown as Promise<Flow>)).Steps;
  };

  it('injects what resolveNamedServices gives for the resolving container', async () => {
    const c = child(root, [
      { name: 'other', service: 'OtherStep' },
      { name: 'root', service: 'RootStep' },
    ]);
    c.register(OtherStep).as(Step);

    const injected = await flowOf(c);
    const listed = await resolveNamedServices(c, 'flow.steps', Step, { lineage: true, keyBy: 'name' });

    expect([...injected.keys()]).to.deep.equal(['other', 'root']);
    expect([...injected.keys()]).to.deep.equal([...listed.keys()]);
    expect(injected.get('other')).to.be.instanceOf(OtherStep);
  });

  it('lists per container: each child injects its own list', async () => {
    const a = child(root, [{ name: 'root', service: 'RootStep' }]);
    const b = child(root, null);

    expect([...(await flowOf(a)).keys()]).to.deep.equal(['root']);
    expect([...(await flowOf(b)).keys()]).to.deep.equal([]);
  });

  it('rejects the resolve with what resolveNamedServices throws', async () => {
    const c = child(root, [{ name: 'totp', service: 'TotpStep' }]);

    const error = await flowOf(c).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).to.be.instanceOf(ServiceNotFound);
    expect((error as Error).message).to.equal('flow.steps entry "totp": no Step is registered as service "TotpStep"');
  });

  it('needs the element type, which reflection of a Map cannot give', () => {
    // @ts-expect-error the type is required
    AutoinjectNamedServices('flow.steps', undefined, { lineage: true, keyBy: 'name' });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/autoinject-lineage.test.ts`
Expected: the tsc diagnostic `Module '"../src/decorators.js"' has no exported member 'AutoinjectNamedServices'`.

- [ ] **Step 3: Implement the decorator**

In `packages/configuration/src/decorators.ts`, after the closing brace of `resolveNamedServices`:

```ts
/**
 * Injects what {@link resolveNamedServices} gives for `path` in the resolving container: a Map keyed by each entry's
 * `keyBy`, in list order, looked up across the container lineage. Resolved when the instance is built, so an unknown
 * service or a bad list rejects that resolve.
 *
 * @example
 * ```ts
 * @AutoinjectNamedServices('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' })
 * protected Steps: Map<string, MfaStep>;
 * ```
 */
export function AutoinjectNamedServices<T>(path: string, type: Class<T>, options: IAutoinjectServiceOptions) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target: Class<unknown>, propertyKey: string | symbol) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      data: path,
      resolveFunc: (data: string, container: IContainer) => resolveNamedServices(container, data, type, options),
    });
  });
}
```

`AddDependencyForProperty`, `IInjectDescriptor`, `IContainer` and `Class` are already imported in this file (`AutoinjectService` uses them). Check the import block and add any that are missing.

- [ ] **Step 4: Run the tests and the configuration suite**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/autoinject-lineage.test.ts`
Expected: every `resolveNamedServices` test passes, plus 4 `@AutoinjectNamedServices` tests.

Run: `cd packages/configuration && npm test`
Expected: no failures.

- [ ] **Step 5: Release note**

In `RELEASE_NOTES.md`, replace:

```markdown
- Configuration: `resolveNamedServices(container, path, type, options)` resolves the services a list
  at `path` names, keyed by `options.keyBy`.
```

with:

```markdown
- Configuration: `resolveNamedServices(container, path, type, options)` resolves the services a list
  at `path` names, keyed by `options.keyBy`; `@AutoinjectNamedServices(path, type, options)` injects
  that map when the instance is built.
```

- [ ] **Step 6: Commit**

```bash
git add packages/configuration/src/decorators.ts packages/configuration/test/autoinject-lineage.test.ts RELEASE_NOTES.md
git commit -m "feat(configuration): @AutoinjectNamedServices injects the services a config list names"
```

---

### Task 3: `ConfiguredMfaPolicy` uses the decorator

**Files:**
- Modify: `packages/authn/src/flow/default-mfa-policy.ts`
- Modify: `packages/authn/src/flow/README.md` (paragraph starting `` `ConfiguredMfaPolicy`, the base of ``)
- Test (unchanged, must stay green): `packages/authn/test/flow/mfa.test.ts`, `packages/authn/test/flow/readme-examples.test.ts`, `packages/authn/test/service/default-authn-service.test.ts`, `packages/authn/test/contracts/boundary.test.ts`

**Interfaces:**
- Consumes: `AutoinjectNamedServices` (Task 2).
- Produces: `ConfiguredMfaPolicy.steps(): Promise<ReadonlyMap<string, MfaStep>>` behaves exactly as it does now:
  - steps are listed once, while the policy resolves
  - a non-step service fails with ``InvalidOption('authn.mfa.steps entry "x": the service is not an MfaStep')``
  - an instance a factory returns rejects with `InvalidOperation`

  `DefaultMfaPolicy` keeps its public API (`force`, `forceForRoles`, `required`, `steps`).

- [ ] **Step 1: Pin the behaviour the refactor must keep**

These existing tests already pin it. Run them before touching code:

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts test/flow/readme-examples.test.ts`
Expected: all passing. Note the count.

Then add one test to `packages/authn/test/flow/mfa.test.ts`, inside `describe('authn.mfa.steps', …)`. It covers the factory case, which nothing tests yet:

```ts
    it('a ConfiguredMfaPolicy a factory returns has no steps to give', async () => {
      class Bare extends ConfiguredMfaPolicy {
        async required(): Promise<readonly string[]> {
          return [];
        }
      }
      await assert.rejects(new Bare().steps(), (e: Error) => e instanceof InvalidOperation && e.message.includes('was not created by DI'));
    });
```

and extend the imports:

```ts
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { ConfiguredMfaPolicy, DefaultMfaPolicy, MfaEnrolmentMismatch, MfaEnrolments, MfaStep, MfaStepNotListed, RoleSource } from '../../src/index.js';
```

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts`
Expected: passes against the current code. It's a pin, not a red test.

- [ ] **Step 2: Replace the listing with the decorator**

In `packages/authn/src/flow/default-mfa-policy.ts`:

Imports become:

```ts
import { Autoinject, Container, Injectable, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { AutoinjectNamedServices, Config } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
```

Replace the whole `ConfiguredMfaPolicy` class and the `listSteps` function with:

```ts
/**
 * An MfaPolicy whose steps are those of `authn.mfa.steps`, keyed by name in list order and looked up by service name
 * across the container lineage (nearest first). Listed as the policy resolves, so a bad list fails the boot, and kept
 * for the life of the instance: a later Configuration.set changes nothing until the policy is resolved anew. Fails on
 * an unknown service (ServiceNotFound), an entry name that differs from the step's own `name` and a service that is
 * not an MfaStep (InvalidOption). Extend it to give a custom policy the configured steps.
 */
export abstract class ConfiguredMfaPolicy extends MfaPolicy {
  // Undefined for an instance a factory returns: only DI injects it.
  @AutoinjectNamedServices('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' })
  protected Steps: Map<string, MfaStep> | undefined;

  public async resolve(): Promise<void> {
    // Duck-typed: steps built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
    for (const [name, step] of this.Steps ?? []) {
      if (typeof step.verify !== 'function' || typeof step.enrolled !== 'function') {
        throw new InvalidOption(`authn.mfa.steps entry ${JSON.stringify(name)}: the service is not an MfaStep`);
      }
    }
    await super.resolve();
  }

  public async steps(): Promise<ReadonlyMap<string, MfaStep>> {
    if (!this.Steps) throw new InvalidOperation(`${this.constructor.name} was not created by DI and has no container to list authn.mfa.steps from`);
    return this.Steps;
  }
}
```

In `DefaultMfaPolicy`, the container used to come from the base. Autoinject it here and drop the private `container` getter:

```ts
export class DefaultMfaPolicy extends ConfiguredMfaPolicy {
  @Autoinject(Container)
  protected Container: IContainer;

  @Config('authn.mfa.policy.force')
  protected Force: boolean;
  …
```

Replace every `this.container.` in the class with `this.Container.`. There are four: `hasRegistered`, `resolve(Array.chainOf(MfaEnrolments))`, `resolve(PrincipalFactory)` and `resolve(RoleSource)`.

- [ ] **Step 3: Run the pinned tests**

Run: `cd packages/authn && npx tsc -b tsconfig.mjs.json && npx ts-mocha -p tsconfig.json test/flow/mfa.test.ts test/flow/readme-examples.test.ts`
Expected: same count as Step 1, plus the new test, all passing. Watch in particular:
- `fails boot on an unknown service, a name mismatch and a non-step`
- `refuses an identical entry listed twice that comes past the schema (Configuration.set)`
- `lists the steps once per policy`
- `DefaultMfaPolicy refuses a listed service that is not an MfaStep, as the boot does`

If `refuses an identical entry listed twice…` fails because DI kept a rejected resolve of the policy, stop and report it. Don't work around it. Retrying a failed resolve is a DI behaviour question, outside this plan.

- [ ] **Step 4: Full authn suite (includes the contracts boundary and cjs probes)**

Run: `cd packages/authn && npm test`
Expected: 0 failing (899 passing with the new test).

- [ ] **Step 5: Dependent suites**

Run each of these, one at a time. They share `node_modules` builds; authn's pretest rebuilds `lib/`.

```bash
cd packages/authn-testing && npm test
cd packages/users && npm test
cd packages/authn-http && npm test
```

Expected: 0 failing in each. `N8bKeyLoginMfaPolicy` in `authn-http/test/v3-app/behaviour/n8b-harness.ts` extends `ConfiguredMfaPolicy`, and DI walks parent classes for autoinject (`Container.extractDescriptor`, `geAllTypes`), so it inherits the decorated `Steps`.

- [ ] **Step 6: README**

In `packages/authn/src/flow/README.md`, replace the first sentence of the paragraph that starts `` `ConfiguredMfaPolicy`, the base of `DefaultMfaPolicy`, lists the steps when ``. The current paragraph opens:

```markdown
`ConfiguredMfaPolicy`, the base of `DefaultMfaPolicy`, lists the steps when
the policy resolves (at the authn boot when any strategy is interactive) and
keeps them for the life of the instance.
```

Make it open:

```markdown
`ConfiguredMfaPolicy`, the base of `DefaultMfaPolicy`, takes the steps through
`@AutoinjectNamedServices('authn.mfa.steps', MfaStep, …)` when the policy
resolves (at the authn boot when any strategy is interactive) and keeps them
for the life of the instance.
```

Leave the rest of the paragraph as it is.

- [ ] **Step 7: Graph and commit**

```bash
graphify update .
git add packages/authn/src/flow/default-mfa-policy.ts packages/authn/src/flow/README.md packages/authn/test/flow/mfa.test.ts
git commit -m "refactor(authn): ConfiguredMfaPolicy takes authn.mfa.steps through @AutoinjectNamedServices"
```

---

## Self-review

- **Coverage:** decorator (Task 2) on a DI hook (Task 1), used in a class (Task 3), docs in Tasks 1–3. `StrategyRegistry` is out of scope, with the reason in Decisions.
- **Placeholders:** none. Every code step shows the code.
- **Names:** `resolveFunc`, `AutoinjectNamedServices`, `IAutoinjectServiceOptions { lineage: true; keyBy }`, `ConfiguredMfaPolicy.Steps` and `DefaultMfaPolicy.Container` are used the same way in every task.
- **Risk:** DI caching a rejected async resolve (Task 3, Step 3), which is flagged and not worked around.
