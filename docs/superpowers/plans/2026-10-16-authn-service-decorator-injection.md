# AuthnService dependencies through DI decorators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `DefaultAuthnService` gets every dependency from DI property decorators. `resolve()` keeps only the boot checks, and there is no constructor-injected container.

**Architecture:** Two small DI features, both built on `IToInject.resolveFunc` (already in the working tree):
- `@Autoinject(X, { check: true })` resolves like `resolve(X, true)` and fails when nothing is registered. `@Autoinject(X, { optional: true })` resolves like `resolveOptional(X)`.
- `@AutoinjectNamedService(path, type, options)` in `@spinajs/configuration` resolves the one service whose name the config value at `path` holds. It looks across the container lineage, can fall back to a default (a name, a class, or a picker function), and can duck-check the instance.

`DefaultAuthnService` then declares all its dependencies, the MFA policy and throttle included, as decorated properties resolved in the resolving container.

**Tech Stack:** TypeScript (mjs + cjs), `@spinajs/di`, `@spinajs/configuration`, mocha + chai (`ts-mocha`).

## Global Constraints

- English for code, comments, docs. Comment only what the code cannot say.
- **No commits, no git index changes** (`add`, `commit`, `stash`, `reset`, `checkout`). The working tree is shared with another session's uncommitted logger refactor. Several files in scope carry its hunks (`@Logger`, log templates), and those must stay untouched.
- `@spinajs/authn/contracts` may import only `@spinajs/di`.
- When `graphify-out/graph.json` exists, run `graphify query "<question>"` before raw grep for a codebase question.
- Decided behaviour (user):
  - `SessionIssuer` and the MFA policy are resolved at **every** boot, interactive strategy or not. A non-interactive app must register a `SessionIssuer`.
  - The throttle default is a picker that keeps K6: the only registered throttle, or the only one besides `MemoryAuthnThrottle`. Otherwise boot fails; it never falls back to memory.
- Error texts tests pin, which must keep holding:
  - `authn.throttle.service "VoidThrottle" is not an AuthnThrottle`
  - `authn.mfa.policy.service "VoidPolicy" is not an MfaPolicy`
  - an unknown name names the path, the name and the registered names: `… "NoSuchPolicy": no MfaPolicy is registered under that name (registered: …DefaultMfaPolicy…)`
  - a missing required neighbour: `Type X is not registered at container`

## File Structure

| File | Change |
| --- | --- |
| `packages/di/src/interfaces.ts` | `IAutoinjectOptions` gets `check?` and `optional?` |
| `packages/di/src/decorators.ts` | `Autoinject` honours them through `resolveFunc` |
| `packages/di/test/autoinject-options.test.ts` | Create |
| `packages/configuration/src/decorators.ts` | `INamedServiceOptions`, `resolveNamedService`, `AutoinjectNamedService` |
| `packages/configuration/test/autoinject-named-service.test.ts` | Create |
| `packages/authn/src/throttle/select.ts` | `selectAuthnThrottle` becomes `AUTHN_THROTTLE_SERVICE` (options with the K6 picker) |
| `packages/authn/src/flow/select-policy.ts` | `selectMfaPolicy` becomes `MFA_POLICY_SERVICE` (options) |
| `packages/authn/src/service/default-authn-service.ts` | Decorated properties; slim `resolve()`; no constructor |
| `packages/authn/src/service/boot/check-config.ts` | Uses `resolveNamedService` |
| authn tests that pin the old conditional boot | Updated (Task 3) |
| `RELEASE_NOTES.md`, `packages/authn/src/flow/README.md` | Notes |

---

### Task 1: `@Autoinject` `check` and `optional`

**Files:**
- Modify: `packages/di/src/interfaces.ts` (`IAutoinjectOptions`, about line 268)
- Modify: `packages/di/src/decorators.ts` (`Autoinject`, about lines 162-200)
- Create: `packages/di/test/autoinject-options.test.ts`
- Modify: `RELEASE_NOTES.md` (section `### DI (`@spinajs/di`)`, next to the `resolveFunc` bullet)

**Interfaces:**
- Produces: `IAutoinjectOptions<T> { mapFunc?; options?; check?: boolean; optional?: boolean }`.
  - `@Autoinject(X, { check: true })` injects `container.resolve(X, true)`, which throws `Type X is not registered at container` when nothing is registered.
  - `@Autoinject(X, { optional: true })` injects `container.resolveOptional(X)`, which is `undefined` when unregistered.
  - Both resolve in the resolving container (the one that builds the owner), and await an async service.
  - They apply to a single class only. Combining either with an array, a `Map` or `Array.chainOf` throws at decoration time.

- [ ] **Step 1: Write the failing test** — `packages/di/test/autoinject-options.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, DI, Injectable } from '../src/index.js';

abstract class Store {
  abstract name(): string;
}

@Injectable(Store)
class MemoryStore extends Store {
  name() {
    return 'memory';
  }
}

abstract class Missing {}

class AsyncDep extends AsyncService {
  public ready = false;
  public async resolve() {
    this.ready = true;
    await super.resolve();
  }
}

class Checked {
  @Autoinject(Store, { check: true })
  public Store: Store;
}

class CheckedMissing {
  @Autoinject(Missing, { check: true })
  public Missing: Missing;
}

class Optional {
  @Autoinject(Missing, { optional: true })
  public Missing: Missing | undefined;

  @Autoinject(Store, { optional: true })
  public Store: Store | undefined;
}

class AsyncChecked {
  @Autoinject(AsyncDep, { check: true })
  public Dep: AsyncDep;
}

describe('@Autoinject check and optional', () => {
  beforeEach(() => {
    DI.clear();
    DI.register(MemoryStore).as(Store);
  });

  it('check injects the registered implementation', () => {
    expect(DI.resolve(Checked).Store).to.be.instanceOf(MemoryStore);
  });

  it('check fails the resolve when nothing is registered, instead of building the abstract base', () => {
    expect(() => DI.resolve(CheckedMissing)).to.throw('Type Missing is not registered at container');
  });

  it('optional injects undefined when nothing is registered, and the implementation when one is', () => {
    const o = DI.resolve(Optional);
    expect(o.Missing).to.equal(undefined);
    expect(o.Store).to.be.instanceOf(MemoryStore);
  });

  it('resolves in the resolving child container', () => {
    const child = DI.child();
    class ChildStore extends Store {
      name() {
        return 'child';
      }
    }
    child.register(ChildStore).as(Store);
    expect(child.resolve(Checked).Store.name()).to.equal('child');
  });

  it('awaits an async service', async () => {
    DI.register(AsyncDep).asSelf();
    const holder = await (DI.resolve(AsyncChecked) as unknown as Promise<AsyncChecked>);
    expect(holder.Dep.ready).to.equal(true);
  });

  it('refuses check or optional on an array property', () => {
    expect(() => {
      class Bad {
        @Autoinject(Store, { optional: true })
        public Stores: Store[];
      }
      return Bad;
    }).to.throw('check and optional take a single class');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd packages/di && npx ts-mocha -p tsconfig.json test/autoinject-options.test.ts`
Expected: a tsc error that `check` / `optional` do not exist in type `IAutoinjectOptions`.

- [ ] **Step 3: Implement**

`packages/di/src/interfaces.ts`:

```ts
export interface IAutoinjectOptions<T> {
  mapFunc?: (x: T) => string;
  options?: any;
  /** Resolve as `resolve(type, true)`: fail when nothing is registered instead of building the type itself. */
  check?: boolean;
  /** Resolve as `resolveOptional(type)`: `undefined` when nothing is registered. */
  optional?: boolean;
}
```

`packages/di/src/decorators.ts`: in `Autoinject`, right after the `if (isConstructor(typeOrOptions)) { … } else { … }` block and before the final `descriptor.inject.push`:

```ts
    if (opt?.check || opt?.optional) {
      if (isArray) {
        throw new Error(`@Autoinject: check and optional take a single class, ${String(propertyKey)} is an array or map`);
      }
      const single = type;
      descriptor.inject.push({
        autoinject: true,
        autoinjectKey: propertyKey,
        inject: single,
        resolveFunc: (_data: unknown, container: IContainer) => (opt!.optional ? container.resolveOptional(single) : container.resolve(single, true)),
      });
      return;
    }
```

Import `IContainer` as a type from `./interfaces.js` if it isn't imported yet. The chain-array branch earlier returns before this block. Also add the same guard at the top of that branch when `opt?.check || opt?.optional`, throwing the same message.

- [ ] **Step 4: Run tests**

Run: `cd packages/di && npx ts-mocha -p tsconfig.json test/autoinject-options.test.ts` (expected: 6 passing), then `cd packages/di && npm test` (expected: 0 failing).

- [ ] **Step 5: Release note**

In `RELEASE_NOTES.md`, under the DI section, after the `resolveFunc` bullet:

```markdown
- `@Autoinject(X, { check: true })` fails the resolve when no `X` is registered (as `resolve(X, true)`);
  `@Autoinject(X, { optional: true })` injects `undefined` then (as `resolveOptional(X)`). Without either,
  an unregistered class is still built from the type itself.
```

---

### Task 2: `@AutoinjectNamedService` (one service named by config)

**Files:**
- Modify: `packages/configuration/src/decorators.ts` (after `AutoinjectNamedServices`)
- Create: `packages/configuration/test/autoinject-named-service.test.ts`
- Modify: `RELEASE_NOTES.md` (the Configuration bullet that names `@AutoinjectNamedServices`)

**Interfaces:**
- Consumes: `IToInject.resolveFunc`; `getOwnConfiguration(container)` (in this file); `container.getRegisteredNames(base)` and `container.resolveNamed(base, name)` (lineage, nearest first).
- Produces:

```ts
export interface INamedServiceOptions<T> {
  /** Used when the value at `path` is unset or ''. A picker gets the registered names and returns one, or undefined when none fits. */
  default?: string | Class<T> | ((registered: readonly string[]) => string | undefined);
  /** Duck check of the resolved instance (instanceof fails across cjs/mjs copies). */
  is?: (instance: unknown) => boolean;
}
export async function resolveNamedService<T>(container: IContainer, path: string, type: Class<T>, options?: INamedServiceOptions<T>): Promise<T>;
export function AutoinjectNamedService<T>(path: string, type: Class<T>, options?: INamedServiceOptions<T>): /* property decorator */;
```

Messages, all `InvalidOption` except the missing-Configuration case, which is `InvalidOperation` as in `resolveNamedServices`. `listed` is the registered names, each `JSON.stringify`ed and joined by `, `, or `none`:
- Unset or `''`, with no default: `${path} is not set (registered: ${listed})`
- Unset, and the picker returns `undefined`: `${path} is not set and no ${type.name} is the default among those registered (${listed}); name one`
- Unknown name: `${path} ${q(name)}: no ${type.name} is registered under that name (registered: ${listed})`
- `is` returns false: `${path} ${q(name)} is not an ${type.name}`

- [ ] **Step 1: Write the failing tests** — `packages/configuration/test/autoinject-named-service.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, PerChildInstance } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { AutoinjectNamedService, resolveNamedService } from '../src/decorators.js';
import { configurationOf, NoSource } from './fixtures.js';

abstract class Engine {
  abstract run(): string;
}
class FastEngine extends Engine {
  run() {
    return 'fast';
  }
}
class SlowEngine extends Engine {
  run() {
    return 'slow';
  }
}

@PerChildInstance()
class Car {
  @AutoinjectNamedService('car.engine', Engine)
  public Engine: Engine;
}

describe('config-named service', () => {
  const containers: IContainer[] = [];
  const child = (parent: IContainer, engine?: unknown) => {
    const c = parent.child();
    c.register(NoSource).as(ConfigurationSource);
    c.register(configurationOf({ car: engine === undefined ? {} : { engine } })).as(Configuration);
    containers.push(c);
    return c;
  };
  let root: IContainer;

  beforeEach(async () => {
    root = child(DI.RootContainer, 'FastEngine');
    root.register(FastEngine).as(Engine);
    root.register(SlowEngine).as(Engine);
    root.register(Car).asSelf();
    await root.resolve(Configuration);
  });

  afterEach(async () => {
    for (const c of containers.splice(0).reverse()) await c.dispose();
  });

  const named = async (c: IContainer, options?: Parameters<typeof resolveNamedService<Engine>>[3]) => {
    await c.resolve(Configuration);
    return resolveNamedService(c, 'car.engine', Engine, options);
  };
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

  it('resolves the registration the config names, across the lineage', async () => {
    expect((await named(child(root, 'SlowEngine'))).run()).to.equal('slow');
  });

  it('the decorator injects the same, per resolving container', async () => {
    const c = child(root, 'SlowEngine');
    await c.resolve(Configuration);
    expect((await (c.resolve(Car) as unknown as Promise<Car>)).Engine.run()).to.equal('slow');
  });

  it('names path, name and registered names for an unknown name', async () => {
    const e = await failure(named(child(root, 'Jet')));
    expect(e).to.be.instanceOf(InvalidOption);
    expect(e!.message).to.equal('car.engine "Jet": no Engine is registered under that name (registered: "FastEngine", "SlowEngine")');
  });

  it('refuses an unset value without a default', async () => {
    const e = await failure(named(child(root, '')));
    expect(e!.message).to.equal('car.engine is not set (registered: "FastEngine", "SlowEngine")');
  });

  it('takes a default name or class when unset', async () => {
    expect((await named(child(root, ''), { default: 'SlowEngine' })).run()).to.equal('slow');
    expect((await named(child(root), { default: FastEngine })).run()).to.equal('fast');
  });

  it('asks a picker with the registered names, and refuses when it returns none', async () => {
    let seen: readonly string[] = [];
    const pick = (names: readonly string[]) => {
      seen = names;
      return names.find((n) => n.startsWith('Slow'));
    };
    expect((await named(child(root), { default: pick })).run()).to.equal('slow');
    expect(seen).to.deep.equal(['FastEngine', 'SlowEngine']);
    const e = await failure(named(child(root), { default: () => undefined }));
    expect(e!.message).to.equal('car.engine is not set and no Engine is the default among those registered ("FastEngine", "SlowEngine"); name one');
  });

  it('refuses an instance the duck check rejects', async () => {
    const e = await failure(named(child(root, 'SlowEngine'), { is: () => false }));
    expect(e!.message).to.equal('car.engine "SlowEngine" is not an Engine');
  });
});
```

If `Parameters<typeof resolveNamedService<Engine>>` doesn't compile with the repo's TS version, type the parameter as `INamedServiceOptions<Engine>` and import it.

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/autoinject-named-service.test.ts`
Expected: a tsc error, `no exported member 'AutoinjectNamedService'`.

- [ ] **Step 3: Implement** — in `packages/configuration/src/decorators.ts`, after `AutoinjectNamedServices`:

```ts
export interface INamedServiceOptions<T> {
  /** Used when the value at `path` is unset or ''. A picker gets the registered names and returns one, or undefined when none fits. */
  default?: string | Class<T> | ((registered: readonly string[]) => string | undefined);
  /** Duck check of the resolved instance (instanceof fails across cjs/mjs copies). */
  is?: (instance: unknown) => boolean;
}

/**
 * The one service of `type` named by the value at `path` in `container`'s configuration, or by `options.default` when
 * that is unset. Looked up by registration name across the container lineage, nearest container first.
 *
 * @throws InvalidOption when no name applies, the name is not registered, or `options.is` rejects the instance
 */
export async function resolveNamedService<T>(container: IContainer, path: string, type: Class<T>, options: INamedServiceOptions<T> = {}): Promise<T> {
  const cfg = getOwnConfiguration(container);
  if (!cfg) {
    throw new InvalidOperation(`Cannot resolve the service of ${path}: the Configuration of the container is not resolved`);
  }

  const registered = container.getRegisteredNames(type);
  const listed = registered.map(q).join(', ') || 'none';
  const value = cfg.get<unknown>(path);
  let name = typeof value === 'string' && value !== '' ? value : undefined;
  if (name === undefined) {
    const fallback = options.default;
    if (fallback === undefined) throw new InvalidOption(`${path} is not set (registered: ${listed})`);
    name = typeof fallback === 'string' ? fallback : isConstructor(fallback) ? fallback.name : fallback(registered);
    if (name === undefined) throw new InvalidOption(`${path} is not set and no ${type.name} is the default among those registered (${listed}); name one`);
  }

  if (!registered.includes(name)) {
    throw new InvalidOption(`${path} ${q(name)}: no ${type.name} is registered under that name (registered: ${listed})`);
  }
  const instance = await container.resolveNamed(type, name);
  if (options.is && !options.is(instance)) {
    throw new InvalidOption(`${path} ${q(name)} is not an ${type.name}`);
  }
  return instance;
}

/**
 * Injects {@link resolveNamedService} for `path` in the resolving container, when the instance is built.
 *
 * @example
 * ```ts
 * @AutoinjectNamedService('authn.mfa.policy.service', MfaPolicy, { default: 'DefaultMfaPolicy' })
 * protected Policy: MfaPolicy;
 * ```
 */
export function AutoinjectNamedService<T>(path: string, type: Class<T>, options?: INamedServiceOptions<T>) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target: Class<unknown>, propertyKey: string | symbol) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      data: path,
      resolveFunc: (data: string, container: IContainer) => resolveNamedService(container, data, type, options),
    });
  });
}
```

Import `isConstructor` from `@spinajs/di` if it is exported there. If it isn't, use `typeof fallback === 'function' && 'prototype' in fallback && fallback.prototype !== undefined` with the arrow-function picker in mind. Arrow functions have no `prototype`, so the check tells a class from a picker. The cleanest fix is to export `isConstructor` from `@spinajs/di`'s root, if it isn't already, and use that.

- [ ] **Step 4: Run tests**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/autoinject-named-service.test.ts` (expected: 7 passing), then `cd packages/configuration && npm test` (expected: 0 failing).

- [ ] **Step 5: Release note** — extend the Configuration bullet that ends `…injects that map when the instance is built.` with:

```markdown
  `resolveNamedService(container, path, type, options)` and `@AutoinjectNamedService` resolve the one
  service the value at `path` names, with an optional default (a name, a class or a picker over the
  registered names) and duck check.
```

---

### Task 3: `DefaultAuthnService` on decorators

**Files:**
- Modify: `packages/authn/src/throttle/select.ts`
- Modify: `packages/authn/src/flow/select-policy.ts`
- Modify: `packages/authn/src/flow/index.ts` (export the policy options instead of `selectMfaPolicy`)
- Modify: `packages/authn/src/service/default-authn-service.ts`
- Modify: `packages/authn/src/service/boot/check-config.ts`
- Modify tests that pin the old conditional boot, at least:
  - `packages/authn/test/service/default-authn-service.test.ts`, the test `needs a SessionIssuer, the MfaPolicy and the MFA steps only when an interactive strategy is listed` (about line 1703)
  - `packages/authn/test/link/account-link-service.test.ts`, `fails without a SessionIssuer` (about line 359)
  - `packages/authn/test/boot/secrets.test.ts`, the test that boots in production with unresolvable steps
  - any other test the suites show booting `DefaultAuthnService` without a `SessionIssuer` or with a broken policy and no interactive strategy
- Modify: `RELEASE_NOTES.md` (authn breaking list) and `packages/authn/src/flow/README.md`

**Interfaces:**
- Consumes: `@Autoinject(X, { check | optional })` (Task 1); `AutoinjectNamedService`, `resolveNamedService` and `INamedServiceOptions` (Task 2).
- Produces:
  - `export const AUTHN_THROTTLE_SERVICE: INamedServiceOptions<AuthnThrottle>`, in `throttle/select.ts`
  - `export function pickAuthnThrottle(registered: readonly string[]): string | undefined`, in `throttle/select.ts`
  - `export const MFA_POLICY_SERVICE: INamedServiceOptions<MfaPolicy>`, in `flow/select-policy.ts`
  - `selectAuthnThrottle` and `selectMfaPolicy` are removed.

- [ ] **Step 1: Options instead of selector functions**

`packages/authn/src/throttle/select.ts`, replacing `selectAuthnThrottle`:

```ts
import type { INamedServiceOptions } from '@spinajs/configuration';
import { isPlainObject } from '@spinajs/util';

import type { AuthnThrottle } from '../contracts/throttle.js';

const MEMORY_THROTTLE = 'MemoryAuthnThrottle';

/** K6: the only registered throttle, or the only one besides MemoryAuthnThrottle, which the core always registers; never a fallback to memory. */
export function pickAuthnThrottle(registered: readonly string[]): string | undefined {
  if (registered.length === 1) return registered[0];
  const others = registered.filter((n) => n !== MEMORY_THROTTLE);
  return others.length === 1 ? others[0] : undefined;
}

/** `authn.throttle.service`, resolved by `@AutoinjectNamedService` and `resolveNamedService`. */
export const AUTHN_THROTTLE_SERVICE: INamedServiceOptions<AuthnThrottle> = {
  default: pickAuthnThrottle,
  is: (t) => isPlainObject(t) && typeof t.attempt === 'function' && typeof t.succeed === 'function',
};
```

`packages/authn/src/flow/select-policy.ts`, replacing `selectMfaPolicy`:

```ts
import type { INamedServiceOptions } from '@spinajs/configuration';
import { isPlainObject } from '@spinajs/util';

import type { MfaPolicy } from '../contracts/mfa.js';

/** `authn.mfa.policy.service` (schema default DefaultMfaPolicy), resolved by `@AutoinjectNamedService` and `resolveNamedService`. */
export const MFA_POLICY_SERVICE: INamedServiceOptions<MfaPolicy> = {
  default: 'DefaultMfaPolicy',
  is: (p) => isPlainObject(p) && typeof p.required === 'function' && typeof p.steps === 'function',
};
```

`isPlainObject` was already the check both selectors used, so keep it. `flow/index.ts` keeps `export * from './select-policy.js'`.

- [ ] **Step 2: `DefaultAuthnService` properties**

In `packages/authn/src/service/default-authn-service.ts`:
- Remove `@Inject(Container)` from the class and the `constructor(private readonly container: IContainer)`.
- Replace the private fields `registry`, `auditor`, `throttle`, `identities`, `principals`, `links`, `sessions` and `policy` with:

```ts
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(Configuration)
  protected Configuration: Configuration;

  @Autoinject(StrategyRegistry)
  protected Registry: StrategyRegistry;

  @Autoinject(AuthnAudit)
  protected Auditor: AuthnAudit;

  @Autoinject(IdentityStore, { check: true })
  protected Identities: IdentityStore;

  @Autoinject(PrincipalFactory, { check: true })
  protected Principals: PrincipalFactory;

  @Autoinject(IdentityLinkStore, { optional: true })
  protected Links: IdentityLinkStore | undefined;

  @Autoinject(SessionIssuer, { check: true })
  protected Sessions: SessionIssuer;

  @AutoinjectNamedService('authn.mfa.policy.service', MfaPolicy, MFA_POLICY_SERVICE)
  protected Policy: MfaPolicy;

  @AutoinjectNamedService('authn.throttle.service', AuthnThrottle, AUTHN_THROTTLE_SERVICE)
  protected Throttle: AuthnThrottle;
```

- Keep `peeker` as it is.
- Drop the `@Config` fields `PolicyService` and `ThrottleService` if nothing else reads them; keep them if something does.
- Rename every use in the file: `this.registry` → `this.Registry`, `this.auditor` → `this.Auditor`, `this.throttle` → `this.Throttle`, `this.identities` → `this.Identities`, `this.principals` → `this.Principals`, `this.links` → `this.Links`, `this.sessions!` / `this.sessions` → `this.Sessions`, `this.policy!` / `this.policy` → `this.Policy`, `this.container` → `this.Container`.
- `MfaPolicy`, `AuthnThrottle`, `SessionIssuer`, `IdentityStore`, `PrincipalFactory` and `IdentityLinkStore` must now be value imports, since the decorators read them at runtime.
- Leave every logger hunk of the other session as it is.

`resolve()` becomes:

```ts
  public async resolve(): Promise<void> {
    if (authnEnvFellBack(this.Configuration)) this.warnOnce(AUTHN_ENV_FALLBACK_WARNING);
    await checkAuthnSecrets(this.Configuration, () => this.Policy.steps(), (m) => this.warnOnce(m));
    await this.Throttle.checkConfiguration?.(this.Configuration);
    if (canPeek(this.Throttle)) this.peeker = this.Throttle;
    else if (this.Registry.strategies().some((s) => !s.interactive)) this.warnOnce(NO_PEEK_WARNING);
    await super.resolve();
  }
```

Update the class doc comment. It must say that a `SessionIssuer` and the MFA policy are resolved at every boot, and stop saying "when an interactive strategy is listed".

- [ ] **Step 3: `check-config.ts`**
  - `throttleFindings`: `throttle = await resolveNamedService(container, 'authn.throttle.service', AuthnThrottle, AUTHN_THROTTLE_SERVICE)`. Keep its `safeMessage(e, 'selecting the throttle')` finding.
  - The MFA policy block: `policy = await resolveNamedService(container, 'authn.mfa.policy.service', MfaPolicy, MFA_POLICY_SERVICE)`. The `?? 'DefaultMfaPolicy'` fallback is now the options' `default`.
  - Remove the imports of `selectAuthnThrottle` and `selectMfaPolicy`.
  - Check that `container.resolve(Configuration)` in `checkAuthnConfig` and `getOwnConfiguration(container)` are the same object (it's the container's own Configuration). If they aren't, stop and report NEEDS_CONTEXT.

- [ ] **Step 4: Tests for the new boot semantics**
  - Rewrite the `default-authn-service.test.ts` test `needs a SessionIssuer, the MfaPolicy and the MFA steps only when an interactive strategy is listed` as `needs a SessionIssuer, the MfaPolicy and the MFA steps at every boot`, with these cases:
    - `bootFails([failing()], { omit: ['SessionIssuer'] }, 'SessionIssuer', 'is not registered at container')`
    - `bootFails([failing()], { raw: { authn: { mfa: { policy: { service: 'NoSuchPolicy' } } } } }, 'authn.mfa.policy.service', 'NoSuchPolicy', 'DefaultMfaPolicy')`
    - `bootFails([failing()], { raw: { authn: { mfa: { steps: [{ name: 'gone', service: 'NoSuchStep' }] } } } }, 'authn.mfa.steps', 'NoSuchStep')`
    - the same three with the interactive strategy
  - `account-link-service.test.ts` `fails without a SessionIssuer`: if `buildCore` now fails because `AuthnService` resolves first, assert that the rejection names `SessionIssuer … is not registered at container` (wrap `buildCore` in `assert.rejects`).
  - `secrets.test.ts`: a boot whose steps cannot be resolved now fails while the policy is injected, before the secrets check. Make the test assert the steps error (`authn.mfa.steps`, the service name) and not the `encryptionKey` framing. Keep the A24 test (a resolvable secret-storing step with no key fails boot in production) as it is.
  - Run `cd packages/authn && npm test`. Fix every other failing test that boots without a `SessionIssuer`, or that relies on the old order, by registering a `SessionIssuer` or updating the expectation. Don't fix tests unrelated to boot; report them.

- [ ] **Step 5: Docs**
  - `RELEASE_NOTES.md` authn breaking list, beside the `MfaPolicy` bullets. The bullet that names `selectMfaPolicy` becomes:

```markdown
- **`DefaultAuthnService` resolves a `SessionIssuer` and the MFA policy at every boot**, also when only
  per-request strategies (tokens, keys) are listed: such an app must register a `SessionIssuer` too. Its
  dependencies are DI property decorators (`@Autoinject`, `@AutoinjectNamedService` with
  `MFA_POLICY_SERVICE` and `AUTHN_THROTTLE_SERVICE`).
```

  - `packages/authn/src/flow/README.md`: in the paragraph that says when `ConfiguredMfaPolicy` takes the steps, replace "(at the authn boot when any strategy is interactive or, with none, when `authn.mfa.encryptionKey.secret` is unset; …)" with "(at every authn boot; …)".

- [ ] **Step 6: Dependent suites**

Rebuild libs first, since authn-http and the cjs probes load them:

```bash
cd packages/di && npm run compile && npm run compile:cjs
cd ../configuration && npm run compile && npm run compile:cjs
cd ../.. && node scripts/generate-packages-for-modules.mjs
cd packages/authn && npm test
cd ../authn-testing && npm test
cd ../users && npm test
cd ../authn-http && npm test && npx ts-mocha -p tsconfig.json --config .mocharc.v3-app.json
```

Expected: 0 failing. Some apps or harnesses boot `DefaultAuthnService` with only per-request strategies and no `SessionIssuer` (token/key test apps). Those now fail by design: give them a `SessionIssuer` (the kit's `MemorySessionIssuer`) and list each one changed in the report. A missing `lib/cjs` is environmental: run that package's `compile:cjs` plus the generate script.

- [ ] **Step 7:** `graphify update .` from the repo root.

---

## Self-review

- **Coverage:**
  - DI required/optional injection: Task 1
  - config-named single service with a default, a picker and a duck check: Task 2
  - every `DefaultAuthnService` dependency as a decorator, no constructor container, slim `resolve()`: Task 3
  - user decisions (eager `SessionIssuer` and policy; K6 picker): Task 3, Steps 1, 2 and 4
  - check-config: Task 3, Step 3
- **Names:** `check`/`optional`, `INamedServiceOptions`, `resolveNamedService`, `AutoinjectNamedService`, `AUTHN_THROTTLE_SERVICE`, `pickAuthnThrottle` and `MFA_POLICY_SERVICE` are used the same way in every task.
- **Out of scope:**
  - authn-http's `mfaPolicyOf` (its own messages and tests)
  - `StrategyRegistry`
  - the per-login `ExternalLoginHook` chain, which stays on `this.Container` on purpose so late-registered hooks run
