# Configuration Injection and Schema Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classes resolved by DI get configuration through `@Config` and rely on the registered JSON schemas for validation and defaults. Manual `container.resolve(Configuration).get(...)` reads and hand-written validators go away.

**Architecture:** Phase 0 fixes the configuration package so `@Config` can replace the manual reads:
- `@Config` reads the Configuration of the container that built the instance, so per-child services keep reading a child's own configuration.
- Schemas are collected from the whole container lineage.
- An absent module still gets its schema defaults.
- A schema registered after boot is still applied.

Phase 1 migrates one feature (authn audit) end to end as the pilot. Phases 2 to 6 apply the same recipe package by package. Each later phase is expanded into its own detailed task plan, from the inventory in this file, before it runs.

**Tech Stack:** TypeScript, `@spinajs/di`, `@spinajs/configuration` (Ajv 8 with ajv-formats, ajv-keywords and ajv-merge-patch), mocha with chai, ts-mocha.

## Global Constraints

- Code comments, identifiers and commit messages are in English. Comment only what the code cannot say.
- Work on branch `authz-v3-refactor`, one commit per task, and run the package suites before each commit.
- Every test command runs from the package directory: `npx ts-mocha -p tsconfig.json <file>`. A package's full suite is `npm test`.
- A package that consumes a changed package reads it from `lib/`. Rebuild before testing dependents: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in the changed package.
- Working-copy files use CRLF. Keep them CRLF.
- A value check moves into the module's JSON schema. Code keeps only checks a schema cannot make:
  - lookups in DI (is a service of this name registered);
  - compiling a value (a rule expression);
  - merging values across authz domains.
- Defaults move into the schema (`default`, applied by `useDefaults`). The authz domain tree is the exception (see Task 13).

---

## Decisions this plan takes (confirm before Phase 0)

1. **Per-child configuration is kept, through the injection.** `@Config` today reads `DI.get(Configuration)`, which is always the root. authn services are `@PerChildInstance` and read "the resolving container's configuration" by design; tests register a child `Configuration`. `@Config` therefore injects `Configuration` as a hidden autoinjected dependency, so DI hands each instance the Configuration of the container that builds it.
2. **Errors change type.** A bad value fails the boot with `InvalidConfiguration` instead of `InvalidOption`. Each violation carries the full configuration path of the bad value (for example `authn.audit.sampleUse`), the schema it was checked against (`$id`, else `$configurationModule`), and the message. The error message lists them all. Tests assert `violations[].path`.
3. **Rules across fields** use Ajv `$data` (for example, `minLength` no greater than `maxLength`). Phase 0 enables `$data`.
4. **Test seams stay.** Constructor `Options`/`Deps` parameters stay for now. A class reads `this.Options?.x ?? this.ConfiguredX`, and the `@Config` property is the configured value.
5. **Out of scope:** validating `Configuration.set()` at runtime and db-source watch updates; removing the 2.x deprecated paths (`rbac.*`, LoginController 2FA). Task 2 records the configuration items in `packages/configuration/TODO.md`.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/configuration/src/decorators.ts` | `@Config` injects Configuration and reads it from the instance | 1 |
| `packages/configuration/test/config-injection.test.ts` (new) | Per-container `@Config` behaviour | 1 |
| `packages/configuration/src/configuration.ts` | Schemas from the lineage, defaults for an absent module, `$data`, applying a late schema | 2, 3 |
| `packages/configuration/src/schemas.ts` (new) | `registerConfigurationSchema()` | 3 |
| `packages/configuration/test/schema-validation.test.ts` (new) | Validator behaviour | 2, 3 |
| `packages/cli/src/cli.ts` | Bootstrappers run before Configuration resolves | 4 |
| `packages/authn/src/schemas/authn.configuration.ts` | authn schema: defaults and gaps | 5 onward |
| `packages/authn/src/audit/*` | Pilot | 5 |

---

## Phase 0: configuration foundation

### Task 1: `@Config` reads the Configuration of the container that built the instance

**Files:**
- Modify: `packages/configuration/src/decorators.ts:88-104`
- Test: `packages/configuration/test/config-injection.test.ts` (new)

**Interfaces:**
- Produces: `export const CONFIGURATION_INJECTION_KEY = '__configuration__'`. A class with any `@Config` property gets `this[CONFIGURATION_INJECTION_KEY]: Configuration`, injected by DI.

- [ ] **Step 1: Write the failing test**

```ts
import 'mocha';
import { expect } from 'chai';
import { DI, PerChildInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { Config } from '../src/decorators.js';

function configurationOf(values: Record<string, unknown>) {
  const json = JSON.stringify(values);
  return class extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

@PerChildInstance()
class PerChild {
  @Config('feature.value', { defaultValue: 'fallback' })
  public Value: string;
}

class RootSingleton {
  @Config('feature.value')
  public Value: string;
}

class Plain {
  @Config('feature.value')
  public Value: string;
}

describe('@Config reads the Configuration of the container that built the instance', () => {
  beforeEach(async () => {
    DI.clear();
    DI.register(configurationOf({ feature: { value: 'root' } })).as(Configuration);
    // Registered in root: an unregistered type would be created in the resolving child.
    DI.register(PerChild).asSelf();
    DI.register(RootSingleton).asSelf();
    await DI.resolve(Configuration);
  });

  it('a per-child service in a child with its own Configuration reads the child value', async () => {
    const child = DI.child();
    child.register(configurationOf({ feature: { value: 'child' } })).as(Configuration);

    const service = await child.resolve(PerChild);

    expect(service.Value).to.equal('child');
  });

  it('a per-child service in a child without its own Configuration reads the root value', async () => {
    expect((await DI.child().resolve(PerChild)).Value).to.equal('root');
  });

  it('a root singleton reads the root value, also when resolved through a child', async () => {
    const child = DI.child();
    child.register(configurationOf({ feature: { value: 'child' } })).as(Configuration);

    expect((await child.resolve(RootSingleton)).Value).to.equal('root');
  });

  it('an instance built with new falls back to the root Configuration', () => {
    expect(new Plain().Value).to.equal('root');
  });

  it('the default applies when the path is missing', async () => {
    const child = DI.child();
    child.register(configurationOf({})).as(Configuration);

    expect((await child.resolve(PerChild)).Value).to.equal('fallback');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd packages/configuration && npx ts-mocha -p tsconfig.json test/config-injection.test.ts`
Expected: FAIL. The first case gets `'root'` where it expects `'child'`, and the last gets `'root'` where it expects `'fallback'`.

- [ ] **Step 3: Implement**

In `packages/configuration/src/decorators.ts`, replace the body of `Config`:

```ts
export const CONFIGURATION_INJECTION_KEY = '__configuration__';

export function Config(path: string, options?: IConfigEntryOptions) {
  return (target: any, key: string): any => {
    // register conf, so we can expose eg. in db if config is set
    DI.register({ path, options }).asValue('__configuration_property__');

    // Injected rather than read from the root: a child container may register its own Configuration.
    AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>) => {
      if (!descriptor.inject.some((i) => i.autoinjectKey === CONFIGURATION_INJECTION_KEY)) {
        descriptor.inject.push({ autoinject: true, autoinjectKey: CONFIGURATION_INJECTION_KEY, inject: Configuration, mapFunc: undefined });
      }
    })(target, key);

    Object.defineProperty(target, key, {
      get(this: Record<string, Configuration | undefined>) {
        const config = this[CONFIGURATION_INJECTION_KEY] ?? DI.get(Configuration)!;
        return config.get(path, options ? options.defaultValue ?? undefined : undefined);
      },
      enumerable: false,
      configurable: false,
    });
  };
}
```

Update the doc comment above `Config`: the getter now reads the Configuration of the container that built the instance, and falls back to the root for an instance built with `new`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx ts-mocha -p tsconfig.json test/config-injection.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Run the dependants**

Run `npm test` in `configuration`. Rebuild `configuration`, then run `npm test` in authn-local, authn-token, authn-session, authn-http, users, http, http-socket, email and telemetry.
Expected: no new failures. authn-token has 152 failures that exist before this change (`table users has no column named Role` and `no RoleStore is registered`); compare against that baseline.
Watch for one risk: before boot, a class with `@Config` now resolves asynchronously, because Configuration is an AsyncService. Callers that `DI.resolve(X)` without `await` before boot would get a promise. Fix any that turn up by awaiting.

- [ ] **Step 6: Commit**

```bash
git add packages/configuration/src/decorators.ts packages/configuration/test/config-injection.test.ts
git commit -m "feat(configuration): @Config reads the Configuration of the container that built the instance"
```

### Task 2: schemas from the whole lineage, defaults for an absent module, `$data`

**Files:**
- Modify: `packages/configuration/src/configuration.ts:363-394` (`validate`), `:397-447` (`initValidator`)
- Test: `packages/configuration/test/schema-validation.test.ts` (new)

- Modify: `packages/configuration/src/exception.ts`
- Create: `packages/configuration/TODO.md`

**Interfaces:**
- Produces: `FrameworkConfiguration.validateModule(schema: IConfigurationSchema): void` (protected), used by Task 3.
- Produces, in `exception.ts`: `ConfigurationViolation { path: string; schema: string; message: string }` and
  `InvalidConfiguration(message, validationExceptions?: ErrorObject[], violations: ConfigurationViolation[] = [])`.

- [ ] **Step 1: Write the failing tests**

```ts
import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

function configurationOf(values: Record<string, unknown>) {
  const json = JSON.stringify(values);
  return class extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

const WITH_DEFAULTS = {
  $id: 'test-with-defaults',
  $configurationModule: 'withDefaults',
  type: 'object',
  properties: { timeoutMs: { type: 'integer', minimum: 1, default: 2000 } },
};

const REQUIRES_HOST = {
  $id: 'test-requires-host',
  $configurationModule: 'requiresHost',
  type: 'object',
  required: ['host'],
  properties: { host: { type: 'string' } },
};

const RANGE = {
  $id: 'test-range',
  $configurationModule: 'range',
  type: 'object',
  properties: {
    min: { type: 'integer' },
    max: { type: 'integer', minimum: { $data: '1/min' } },
  },
};

async function boot(values: Record<string, unknown>, ...schemas: object[]) {
  const child = DI.child();
  for (const s of schemas) child.register(s).asValue('__configurationSchema__');
  child.register(configurationOf(values)).as(Configuration);
  return { child, config: await child.resolve(Configuration) };
}

describe('configuration schema validation', () => {
  beforeEach(() => DI.clear());

  it('applies the defaults of a module that is not configured at all', async () => {
    const { config } = await boot({}, WITH_DEFAULTS);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('leaves an unconfigured module alone when its schema needs values', async () => {
    const { config } = await boot({}, REQUIRES_HOST);
    expect(config.get('requiresHost')).to.equal(undefined);
  });

  it('validates with the schemas of every ancestor, not only the nearest container', async () => {
    DI.register(WITH_DEFAULTS).asValue('__configurationSchema__');
    await expect(boot({ requiresHost: {}, withDefaults: { timeoutMs: 0 } }, REQUIRES_HOST)).to.be.rejectedWith(InvalidConfiguration);
  });

  it('names the full path, the schema and the message of every bad value', async () => {
    let error: unknown;
    try {
      await boot({ withDefaults: { timeoutMs: 0 } }, WITH_DEFAULTS);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidConfiguration);
    const [v] = (error as InvalidConfiguration).violations;
    expect(v).to.deep.include({ path: 'withDefaults.timeoutMs', schema: 'test-with-defaults' });
    expect(v.message).to.be.a('string').and.not.equal('');
    expect((error as Error).message).to.contain('withDefaults.timeoutMs').and.contain('test-with-defaults');
  });

  it('supports $data references between fields', async () => {
    await expect(boot({ range: { min: 10, max: 5 } }, RANGE)).to.be.rejectedWith(InvalidConfiguration);
    const { config } = await boot({ range: { min: 5, max: 10 } }, RANGE);
    expect(config.get('range.max')).to.equal(10);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx ts-mocha -p tsconfig.json test/schema-validation.test.ts`
Expected:
- The default test fails (undefined).
- The lineage test fails (it resolves, because the child's list hides the root's).
- The `$data` test fails, with the strict-mode error `"$data" is not supported` or no rejection.

- [ ] **Step 3: Implement**

In `initValidator()`, add `$data: true` to `options`. Replace the line that collects schemas:

```ts
    /**
     * load all registered configuration json schemas
     * for config value validation
     */
    this.ValidationSchemas = this.schemasOfLineage();
```

Add the helper next to `initValidator`:

```ts
  // A child that registers a schema of its own must not hide the schemas of its ancestors.
  private schemasOfLineage(): IConfigurationSchema[] {
    const found: IConfigurationSchema[] = [];
    for (let c: IContainer | undefined = this.Container; c; c = c.Parent) {
      for (const s of (c.Cache.get('__configurationSchema__', false) ?? []) as IConfigurationSchema[]) {
        if (!found.includes(s)) found.push(s);
      }
    }
    return found;
  }
```

Replace `validate()`:

```ts
  protected validate() {
    this.ValidationSchemas.forEach((s) => this.validateModule(s));
  }

  protected validateModule(s: IConfigurationSchema) {
    const config = this.get(s.$configurationModule);

    if (!config) {
      // An unconfigured module still gets its schema defaults, unless the schema needs values from the app.
      const empty = {};
      if (this.Validator.validate(s, empty)) {
        this.set(s.$configurationModule, empty);
      } else {
        InternalLogger.warn(`Cannot validate configuration for module ${s.$configurationModule}, configuration is not set`, 'Configuration');
      }
      return;
    }

    if (!this.Validator.validate(s, config)) {
      const errors = this.Validator.errors ?? [];
      const schema = (s as { $id?: string }).$id ?? s.$configurationModule;
      const violations = errors.map((ve) => ({
        path: [s.$configurationModule, ...ve.instancePath.split('/').filter((p) => p !== '')].join('.'),
        schema,
        message: ve.message ?? ve.keyword,
      }));
      violations.forEach((v) => InternalLogger.error('Invalid configuration at %s ( schema %s ): %s', 'Configuration', v.path, v.schema, v.message));

      throw new InvalidConfiguration(`Invalid configuration: ${violations.map((v) => `${v.path} ${v.message} ( schema ${v.schema} )`).join('; ')}`, errors, violations);
    }
  }
```

Import `IContainer` from `@spinajs/di` if `configuration.ts` does not already import it.

Replace `exception.ts`:

```ts
import { ErrorObject } from 'ajv';

export interface ConfigurationViolation {
  /** Full configuration path of the bad value, eg. `authn.audit.sampleUse`. */
  path: string;
  /** The schema checked against: its `$id`, else its `$configurationModule`. */
  schema: string;
  message: string;
}

export class InvalidConfiguration extends Error {
  constructor(message: string, public validationExceptions?: ErrorObject[], public violations: ConfigurationViolation[] = []) {
    super(message);
  }
}
```

Create `packages/configuration/TODO.md`:

```markdown
# TODO

- `Configuration.set()` and `merge()` skip schema validation, so a value set at runtime is never checked.
- `@spinajs/configuration-db-source` pushes db rows with `set()` (`bootstrap.ts` syncConfigOption and the watch poll) without validation.
- `load()` resets the config tree, so a reload drops the defaults the schemas applied and is not validated again.
- `IConfigEntryOptions.required` is stored for admin UIs only; the `@Config` getter does not enforce it.
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx ts-mocha -p tsconfig.json test/schema-validation.test.ts`, then `npm test`.
Expected: all pass. Check `config.test.ts` especially: the existing configuration tests must not change.

- [ ] **Step 5: Run the dependants**

Rebuild `configuration`, then run `npm test` in authn, authz, authz-rbac, authz-http and email.
Expected: no new failures. A schema-bearing module that apps leave unconfigured now gets its defaults. If a test pinned "no key at all", adjust it to the default and note it in the commit.

- [ ] **Step 6: Commit**

```bash
git add packages/configuration/src/configuration.ts packages/configuration/src/exception.ts packages/configuration/TODO.md packages/configuration/test/schema-validation.test.ts
git commit -m "feat(configuration): validate with the schemas of the whole lineage and default unconfigured modules"
```

### Task 3: a schema registered after boot is still applied

**Files:**
- Create: `packages/configuration/src/schemas.ts`
- Modify: `packages/configuration/src/index.ts` (export it), `packages/configuration/src/configuration.ts` (make `validateModule` public)
- Modify the schema bootstrappers to use the helper:
  - `packages/authn/src/service/boot/bootstrap.ts:9`
  - `packages/authz/src/host/config/bootstrap.ts:7`
  - `packages/authz-rbac/src/stores/bootstrap.ts:7`
  - `packages/authz-http/src/http-config.ts:58`
- Test: `packages/configuration/test/schema-validation.test.ts`

**Interfaces:**
- Produces: `registerConfigurationSchema(schema: IConfigurationSchema, container: IContainer = DI.RootContainer): void`.

Why this task exists: `OidcBootstrapper` resolves Configuration inside `bootstrap()`. Every bootstrapper that runs after it then registers its schema too late, and that schema is silently never applied.

- [ ] **Step 1: Write the failing test** (append to `schema-validation.test.ts`)

```ts
import { registerConfigurationSchema } from '../src/schemas.js';

  it('validates and defaults a module whose schema is registered after the Configuration resolved', async () => {
    const { child, config } = await boot({});
    registerConfigurationSchema(WITH_DEFAULTS, child);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('fails at registration when the already loaded module violates the late schema', async () => {
    const { child } = await boot({ range: { min: 10, max: 5 } });
    expect(() => registerConfigurationSchema(RANGE, child)).to.throw(InvalidConfiguration);
  });
```

- [ ] **Step 2: Run and confirm the failure**

Expected: `Cannot find module '../src/schemas.js'`.

- [ ] **Step 3: Implement** `packages/configuration/src/schemas.ts`

```ts
import { DI, IContainer } from '@spinajs/di';
import { Configuration, IConfigurationSchema } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from './configuration.js';

/**
 * Registers a configuration schema. When the Configuration of `container` already resolved, the schema is
 * applied at once; otherwise the Configuration applies it when it boots.
 */
export function registerConfigurationSchema(schema: IConfigurationSchema, container: IContainer = DI.RootContainer): void {
  container.register(schema).asValue('__configurationSchema__');
  const resolved = container.get(Configuration);
  if (resolved instanceof FrameworkConfiguration) resolved.validateModule(schema);
}
```

Change `protected validateModule` to `public validateModule` in `configuration.ts`, and export the file from `index.ts`: `export * from './schemas.js';`.

In each of the four bootstrappers, replace `DI.register(X_SCHEMA).asValue('__configurationSchema__');` with `registerConfigurationSchema(X_SCHEMA);`, imported from `@spinajs/configuration`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run `npx ts-mocha -p tsconfig.json test/schema-validation.test.ts`, then rebuild `configuration` and run `npm test` in authn, authz, authz-rbac and authz-http.

- [ ] **Step 5: Commit**

```bash
git add packages/configuration packages/authn/src/service/boot/bootstrap.ts packages/authz/src/host/config/bootstrap.ts packages/authz-rbac/src/stores/bootstrap.ts packages/authz-http/src/http-config.ts
git commit -m "feat(configuration): apply a configuration schema registered after boot"
```

### Task 4: the CLI runs bootstrappers before Configuration resolves

**Files:**
- Modify: `packages/cli/src/cli.ts:8-16`

- [ ] **Step 1: Change the order**

```ts
async function cli() {
  DI.setESMModuleSupport();

  // Bootstrappers register the configuration schemas; the Configuration applies them when it boots.
  const bootstrappers = DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  await DI.resolve(Configuration);
```

- [ ] **Step 2: Verify**

Run `npm test` in `packages/cli`, `packages/orm-cli` and `packages/authn-http` (the authn CLI commands).
Expected: no new failures. With Task 3 in place, a bootstrapper that itself resolves Configuration is still safe.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "fix(cli): run bootstrappers before the Configuration boots so their schemas apply"
```

---

## Phase 1: pilot, authn audit

### Task 5: `AuthnAudit` and `LogAuthnAuditSink` take `authn.audit` from `@Config` and the schema

**Files:**
- Modify: `packages/authn/src/schemas/authn.configuration.ts:294-308` (audit defaults)
- Modify: `packages/authn/src/audit/authn-audit.ts:67-100`
- Modify: `packages/authn/src/audit/log-sink.ts:38-51`
- Delete from `packages/authn/src/audit/config.ts`: `readAuditConfig`, `readHashKey`, the helpers and `KEYS`. Keep `AuditConfig` and the constants, which the docs and shipped config use.
- Modify: `packages/authn/src/index.ts` (stop exporting `readAuditConfig`)
- Test: `packages/authn/test/audit/authn-audit.test.ts`, `packages/authn/test/audit/log-sink.test.ts`, `packages/authn/test/boot/config-defaults.test.ts`

**Interfaces:**
- Consumes: `@Config` from Task 1; the lineage, defaults and `$data` behaviour from Task 2.
- Produces: the configured values `AuthnAudit.Config: AuditConfig` and `LogAuthnAuditSink.Config: AuditConfig`.

- [ ] **Step 1: Schema defaults**

In `authn.configuration.ts`, in the `audit` block:
- add `default: {}` to `audit` itself, so an unset `authn.audit` still gets the nested defaults;
- add `default: 0.01` to `sampleUse`;
- add `default: 2000` to `sinkTimeoutMs`;
- make `sinks` `{ type: 'array', items: { type: 'string', minLength: 1 } }`, unless `stringList` already says this.
`hashKey.secret` keeps `minLength: 32`, and `propertyNames` keeps unknown keys out, as before.

- [ ] **Step 2: Write the failing tests**

In `authn-audit.test.ts`, replace `boot()` and `bootFails()` so each boot uses a fresh child Configuration (the schema then applies), instead of `cfg.set('authn.audit', ...)` on the root:

```ts
import { InvalidConfiguration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA } from '../../src/index.js';
import { configurationOf } from '../behaviour/harness.js';

  async function boot(audit: unknown, opts?: { random?: () => number; log?: AuditLog }): Promise<AuthnAudit> {
    const child = DI.RootContainer.child();
    children.push(child);
    child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    child.register(configurationOf({ authn: { audit } })).as(Configuration);
    if (!opts) return child.resolve(AuthnAudit);
    const a = new AuthnAudit(child, opts);
    await a.resolve();
    return a;
  }

  async function bootFails(audit: unknown, ...paths: string[]): Promise<void> {
    let error: unknown;
    try {
      await boot(audit);
    } catch (e) {
      error = e;
    }
    expect(error, 'the boot fails').to.be.instanceOf(InvalidConfiguration);
    const found = (error as InvalidConfiguration).violations.map((v) => v.path);
    for (const p of paths) expect(found).to.include(p);
  }
```

Add `const children: IContainer[] = [];` and `afterEach(async () => { for (const c of children.splice(0)) await c.dispose(); });`. Rewrite each `bootFails(x, 'message part')` call to name the full configuration path:
- `bootFails({ sampleUse: 2 }, 'authn.audit.sampleUse')`
- `bootFails({ sinkTimeoutMs: 0 }, 'authn.audit.sinkTimeoutMs')`
- `bootFails({ hashKey: { secret: 'short' } }, 'authn.audit.hashKey.secret')`
- `bootFails({ typo: 1 }, 'authn.audit')` (propertyNames)

Delete the `readAuditConfig` unit tests; the schema cases above replace them.

`AuthnAudit(container, options)` stays, because tests inject `random` and `log`. An instance built with `new` gets no injected Configuration, so `@Config` would fall back to the root. In the `opts` branch of `boot()`, hand it the child's one before `resolve()`:

```ts
    const a = new AuthnAudit(child, opts);
    (a as unknown as Record<string, unknown>)[CONFIGURATION_INJECTION_KEY] = await child.resolve(Configuration);
    await a.resolve();
    return a;
```

`CONFIGURATION_INJECTION_KEY` is imported from `@spinajs/configuration` (Task 1).

In `log-sink.test.ts`, replace the `new LogAuthnAuditSink({ hashKey: ... }, log)` boots with the same pattern: a child Configuration, then `child.resolve(LogAuthnAuditSink)` and setting `sink.out = log`. `out` is already a protected test hook, so give the test class a setter or cast.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd packages/authn && npx ts-mocha -p tsconfig.json test/audit/authn-audit.test.ts test/audit/log-sink.test.ts`
Expected: FAIL. Bad values still raise `InvalidOption` from `readAuditConfig`, because the code still validates by hand.

- [ ] **Step 4: Implement**

`authn-audit.ts`: drop the `Configuration` resolve, the `get()` guard and the `readAuditConfig` call:

```ts
  @Config('authn.audit')
  protected Config: AuditConfig;

  public async resolve(): Promise<void> {
    const config = this.Config;
    // The whole lineage: a child that registers its own sink keeps its ancestors' sinks. Array.chainOf builds each sink
    // where it was registered (a root singleton stays the root's), per-child sinks here; both lists share one order.
    const types = this.container.getRegisteredTypes(Array.chainOf(AuthnEventSink)) ?? [];
    const built = (await this.container.resolve(Array.chainOf(AuthnEventSink))) as unknown[];
```

The rest of `resolve()` stays: name lookup in DI and duck-typing are DI checks, not config checks. `config.sinks` is now `string[] | undefined` straight from the schema, and `sampleUse` and `sinkTimeoutMs` are always set.

`log-sink.ts`: drop `@Inject(Configuration)` and the dual constructor:

```ts
@PerChildInstance()
@Injectable(AuthnEventSink)
export class LogAuthnAuditSink extends AuthnEventSink {
  @Config('authn.audit')
  protected Config: AuditConfig;

  /** Test hook: where lines go. */
  protected out: AuditLog = auditLog('authn-audit');

  private keyBuffer: Buffer | undefined;

  private get key(): Buffer {
    const secret = this.Config.hashKey?.secret;
    return (this.keyBuffer ??= secret ? Buffer.from(secret, 'utf8') : (processKey ??= randomBytes(32)));
  }
```

Then replace `this.hashIdentifiers` with `this.Config.hashIdentifiers`. Update `AuditConfig.hashKey` to the schema shape, `{ secret: string | null } | null | undefined`.

`config.ts`: keep the `AuditConfig` interface (updated) and the exported constants. Delete everything else.

- [ ] **Step 5: Run the tests and confirm they pass**

Run the two audit files, then `test/boot/config-defaults.test.ts`, then `npm test` in authn.
Expected: all pass. `config-defaults` "keeps the other values equal to the code defaults" now reads them from the schema; switch its `DEFAULT_AUDIT_*` comparison to `check({}).config.audit`.

- [ ] **Step 6: Dependants**

Rebuild authn, then run `npm test` in authn-http, authn-orm and users. These use `LogAuthnAuditSink` and the audit boot.

- [ ] **Step 7: Commit**

```bash
git add packages/authn
git commit -m "refactor(authn): authn.audit through @Config and the schema, no hand validation"
```

---

## Phases 2 to 6: the recipe and the inventory

Every class below follows the same recipe as Task 5. Before a phase starts, expand it into a detailed task plan with full test and code steps, one task per row group.

**Recipe:**
1. Move every hand-checked rule and every hand-coded default into the module schema (gaps are listed per row).
2. Write failing tests that boot through a child `configurationOf(...)` and assert `InvalidConfiguration` with `violations[].path`.
3. Replace the manual read with `@Config('<key>')` on the class.
4. Delete the `read*`/`check*` function and its unit tests.
5. Keep only the DI lookups and compiling.
6. Run the package and its dependants, then commit.

### Phase 2: authn core (`packages/authn/src`)

| Class / function | Keys | Delete | Schema additions |
|---|---|---|---|
| `FreshAuthCheck` (`freshauth/fresh-auth-check.ts:57`) | `authn.freshAuth.maxAgeSeconds` | `readMaxAge` | `default` (from `DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS`) |
| `AuthnImpersonationService` (`impersonation/impersonation-service.ts:138`) | `authn.impersonation`, `authn.session.expiration.maxLifetime` | `readSettings` | none (defaults exist) |
| `MfaStepRegistry`, `StrategyRegistry` | `authn.mfa.steps`, `authn.strategies` | shape part of `readNamedEntries` | none. Resolve the conflict: the schema rejects repeated names, while the code dropped exact duplicates. Keep the schema rule. |
| `DefaultMfaPolicy` (`flow/default-mfa-policy.ts:32`) | `authn.mfa.policy.force`, `.forceForRoles`, `authn.mfa.steps` | `readForce`, `readRoles` | none. The "force needs steps" rule becomes an `if/then` in the schema. |
| `DefaultAuthnService` (`service/default-authn-service.ts:179`) | `authn.linking`, `authn.throttle.global`, `authn.mfa.policy.service`, `authn.throttle.service` | `readLinking`; the string checks in `selectPolicy` and `selectThrottle` | `mfa.policy.service` `default: 'DefaultMfaPolicy'` |
| `MemoryAuthnThrottle` (`throttle/memory-throttle.ts:68`) | `authn.throttle` | `readThrottleConfig`, `checkThrottleParams`, `checkMaxRows` | `maxRows` minimum |
| boot checks (`service/boot/secrets.ts`, `legacy-keys.ts`, `check-config.ts`) | secrets, legacy keys | type checks only. The environment-dependent strictness (production needs secrets) stays as a boot check, because a schema cannot read `APP_ENV`. | `pepper.version` maximum 999999999; `pepper.previous` versions unique (`uniqueItemProperties: ['version']`) |

### Phase 3: authn packages

| Package / class | Keys | Delete | Schema additions |
|---|---|---|---|
| authn-http `AuthorizationBearerExtractor`, `ApiKeyHeaderExtractor`, `HttpSignatureExtractor` | `authn.token.prefix`, `.headerName`, `authn.keys.assertion.typ`, `authn.http.publicOrigin` | `@Autoinject(Configuration)` + `.get`, typeof checks, `signaturePublicOrigin` | `http.publicOrigin` (`format: 'uri'`) |
| authn-http `AuthnMiddleware`, `ClientIp`, `CsrfOriginGuard` | `http.cookie.secret`, `authn.http.*`, `authn.session.cookie` | `allowedOrigins`, `isEnabled` | new `http` schema module (`packages/http`): `trustProxy`, `cookie.secret`, `cors`, `throttle` |
| authn-http `MfaSatisfied`, `pendingSteps`, `mfaPolicyOf` | `authn.mfa.policy.service` | the `?? 'DefaultMfaPolicy'` fallbacks | none (Phase 2 default) |
| authn-keys `configuredKeysOptions` + 4 strategies | `authn.keys` | `keysOptions` | `challenge.{ttlSeconds 1-3600, audience}`, `httpSignature.skewSeconds`, `assertion.skewSeconds` max 300 |
| authn-oidc `OidcProviders`, `OidcBootstrapper`, `OidcController`, `FetchOidcHttpClient` | `authn.oidc`, `authn.linking`, trust proxy | `readOidcOptions` and friends; `trustedPeer` (reuse `http` parseTrustProxy) | register `AUTHN_OIDC_CONFIGURATION_SCHEMA` (add `$id`, `$configurationModule: 'authn.oidc'`); provider schema in place of `{type:object}`; `OIDC_APP_PATH_PATTERN` |
| authn-orm `DbAuthnThrottle` | `authn.throttle`, `authn.audit.hashKey.secret` | `throttle/params.ts` (a copy of authn's) | none |
| authn-totp `TotpMfaStep`, `TotpService` | `authn.mfa.encryptionKey`, `authn.mfa.totp`, `authn.freshAuth.maxAgeSeconds` | `totpOptions`, `freshAuthMaxAge` (a copy), the shape part of `mfaKeyRingFrom` | `totp.algorithm` enum `SHA1/SHA256/SHA512`, `period` max 300, `window` max 10, `recoveryCodes` max 100, `encryptionKey.previous`, `encryptionKey.secret` pattern (32-byte hex or base64) |
| authn-local `Argon2PasswordHasher`, `LocalPasswordPolicy`, `PasswordExpirationJob` | already `@Config` | `buildSettings` range and type checks, `checkVersion`, `maxAgeDays > 0` | `policy.maxLength` `minimum: {$data: '1/minLength'}`; `expiration.maxAgeDays` exclusiveMinimum 0 |
| authn-token `checkTokenFormat`, `checkInterval`, `positive()`, `JwtBearerStrategy.issuerOf` | already `@Config` | all of them; `issuerOf` shape (~130 LOC) | cross-field `prefix` + `length` ≤ 1024 stays as one boot check (string length across two values; `$data` cannot add) |
| authn-session `appEnvOf`, `assertSessionCookieSecret` | env, `http.cookie.secret` | duplicates; reuse the authn `env.ts` | none |

### Phase 4: authz core (`packages/authz/src`)

| Class / function | Keys | Delete | Notes |
|---|---|---|---|
| `DefaultAuthzService.boot` (`host/service.ts:303`) | `authz` | type checks in `readDomainConfig` (~145 LOC down to a merge) | Domains inherit from their parent, so defaults inside `authz.domains.<n>` would break inheritance. Root-level defaults move to the schema; `AUTHZ_DEFAULTS` stays only as the merge base for domains. `@Config('authz')` on the service, merged in code by lineage. |
| `DefaultAuthzDomains.configuredParent`, authz-orm `lineageOf` | `authz.domains.<n>.parent` | both string checks; authz-orm reuses `DefaultAuthzDomains` | the schema covers `parent` |
| `DefaultAuthzAdmin.env`, `assertAdminPermission` | `authz.admin` | `readAdminConfig` | new `authz.admin` block in `AUTHZ_CONFIGURATION_SCHEMA`: `maxBatch`, `backend`, `guard.service`, `guard.*` switches, `permissions`, `connection` |
| `ConfigScopeAttributeSchemas` | `authz.scopes.attributes` | shape checks | add `scopes.attributes` to the schema |
| `isProduction()` | `configuration.isProduction` | typeof check | `@Config` on callers |

### Phase 5: authz packages

| Package / class | Keys | Delete | Schema additions |
|---|---|---|---|
| authz-http `httpConfig()` and its 8 callers | `authz.http` | `httpConfig` (~48 LOC, a full duplicate of the schema) | defaults `'authz:explain'`, `'link'`, `'X-Authz-Link'`, `'root'` |
| authz-http `AccessPolicy.trace`, `auditUnscoped`, `decisionFields`, `PrincipalMiddleware` | `authz.engine.explain`, `authz.audit`, `authz.fields`, `authz.principals.anonymous.enabled` | root `readDomainConfig` calls | none |
| authz-http-admin `adminDomain` | `authz.http.admin.domain` | string check | add `http.admin.domain` |
| authz-rbac `DefaultAdminGuard`, users-http `DefaultAccountGuard` | `authz.admin.guard` | `readGuardConfig` | from Phase 4 |
| authz-rbac `DbAuthzAdminBackend`, authz-orm `DbScopeAttributeStore` | `authz.admin.connection` | both string checks | `default: 'default'` |
| authz-rbac `ConfigRoleStore` | `authz.rbac.roles`, `.ladders` | helpers (~110 LOC, 1:1 with the schema) | none |
| authz-rbac `ConfigRuleStore` / `readRuleDefs` | `authz.rbac.rules` | its own AJV `RULE_SCHEMA` | move `RULE_SCHEMA` into `AUTHZ_RBAC_CONFIGURATION_SCHEMA.rules.items`; scope/id/resource checks stay only if they need DI |
| authz-rbac `DbLinkStore.secret` | `authz.rbac.links.secret` | length ≥ 32 check | none |
| authz-rbac `storeConnection` | `authz.rbac.connection` | none | default via `anyOf` fallback in code (two keys) |
| authz-rbac model `anonymousRoles`, `serviceRoles`, `cacheConfig`, `groupPrincipalConfig` | `authz.rbac.*` via `ctx.config` | type checks | `cache.maxSubjects`, `cache.rolesCheckSeconds`. Resolve the conflict: the schema requires both `groupPrincipal` fields, while the code accepts `null` and partial objects. Allow `null` and give the fields defaults. |
| authz-rbac `tokenRoleExtension` / `loadTokenRoleRules` | `authz.token` | list and pattern checks | new `authz.token` block |
| authz-abac `storesFromConfig`, `ConfigPolicyStore` | `authz.abac` | type checks | new `authz.abac` block |
| authz-fs `fsAccessConfig` and its 8 callers, `fsMetadataConnection` | `authz.fs.<fs>`, `authz.fsMetadata.connection` | `parseFsAccessConfig` (~140 LOC) | new `authz.fs` schema (patternProperties per fs); `stampOwner` needs `metadata` via `if/then` |
| authz-orm `domainName`, authz-queue `authzFor`, `QueueChangeBus.route` | `authz.orm.domain`, `authz.queue.domain`, `authz.bus.topic` | string checks | defaults `'root'` |

### Phase 6: users, users-http, telemetry, http

| Package / class | Keys | Delete | Schema additions |
|---|---|---|---|
| users `target-guard.ts` (`accessDomain`, `impersonationPermission`, `protectedRoles`) | `authz.http.access.domain`, `authz.impersonation.*` | string and list checks | `authz.impersonation` block |
| users `RbacRoleSource.passwordRule` | `authz.principals.roleSwitch.requirePassword` | list check | none |
| users `defaultRoles`, `DefaultRolesBootCheck` | `authz.rbac.defaultRoles` | `defaultRoles` trim and type (the schema covers it) | none |
| users-http `roleDefinitions` | `authz.rbac.roles` | none | none |
| telemetry `TelemetryAccessPolicy`, `TelemetryAccessContributor`, `telemetrySkipsAuth` | `telemetry.auth.*` | ~30 LOC of checks | new `telemetry` schema |
| http `RealIp`, `CorsMiddleware`, `ThrottleMiddleware`; http-socket `assertLimitsConfig` | `http.*`, `http.socket` | `parseTrustProxy` shape part, origin list checks, `assert*Config` (~48 LOC) | the `http` schema from Phase 3; an `http.socket` block |

### Out of scope here (follow-ups)

- `Configuration.set()` and the db-source watch skip schema validation (`configuration-db-source/src/bootstrap.ts:172,196`), and `load()` drops applied defaults on reload.
- authz-http, authz-orm and users-http read some keys from the root Configuration while the host reads them from the domain container. Today these are the same object, because authz domains have no Configuration of their own. With `@Config` injected per container they stay consistent.
- The deprecated 2.x paths: `rbac.*`, `LoginController.configuredStepRequired`, `twoFaProvider`.

## Self-review notes

- Spec coverage:
  - `@Config` in DI classes: Tasks 1 and 5 and every phase table.
  - Schema validation in place of hand checks: Tasks 2, 3 and 5 and the table columns.
  - The whole feature branch: the tables cover every manual read and hand validator found in the changed `packages/*/src` files.
- Risk points:
  - Task 1 makes an `@Config` class resolve asynchronously before boot.
  - Task 2 gives an unconfigured module its defaults.
  - Both have a dependants run step.
