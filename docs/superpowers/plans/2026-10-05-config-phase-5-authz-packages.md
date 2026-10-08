# Configuration Phase 5: authz packages through `@Config` and JSON schemas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** authz-http, authz-http-admin, authz-rbac, authz-abac, authz-fs, authz-orm and authz-queue stop validating `authz.*` by hand, and so does users-http `DefaultAccountGuard`, which shares `authz.admin.guard`. Every value check and every hand-coded default named in `.superpowers/sdd/phase-5-inventory.md` moves into a JSON schema. A DI class reads its value through `@Config`.

**References:**
- Recipe: `.superpowers/sdd/recipe.md`.
- Mechanism: `.superpowers/sdd/mechanism-notes.md`.
- Constraints: `.superpowers/sdd/global-constraints.md`:
  - code and commits in English;
  - one commit per task;
  - CRLF in the working copy;
  - run tests with `npx ts-mocha -p tsconfig.json <file>` from the package directory;
  - before testing a package's dependants, rebuild it with `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`.

## Prerequisites (on the branch before Task 5.1)

- **Phase 0, committed.**
  - The working-copy change of `packages/configuration/src/decorators.ts`: `@Config` injects the resolving container under `CONFIGURATION_CONTAINER_KEY`. Reading the property throws `InvalidOperation` while that container's Configuration is not resolved.
  - Every snippet below uses `CONFIGURATION_CONTAINER_KEY`.
  - `packages/configuration` rebuilt (mjs and cjs).
- **Phase 4 (authz core), merged.** This plan consumes the following and does not re-plan it:
  - `AUTHZ_CONFIGURATION_SCHEMA.properties.admin` with:
    - `maxBatch`, `backend`, `permissions`;
    - `connection` (string, `minLength: 1`);
    - `guard`:
      - `service`;
      - `privilegedPermission`, with the permission-name pattern;
      - the switches `protectSystemRole`, `preventEscalation`, `preventSelfLockout`, `preventLastPrivilegedRemoval`, each `{ type: 'boolean', default: true }`;
      - an `if/then` that requires `privilegedPermission` while `preventSelfLockout` or `preventLastPrivilegedRemoval` is true.
  - `scopes.attributes`.
  - Root-level defaults in the schema, among them `principals.anonymous.enabled: true`.
  - `readDomainConfig(read: ConfigGetter, lineage)`, still exported from `@spinajs/authz` and reduced to the merge. `AUTHZ_DEFAULTS` is still exported as its merge base. If Phase 4 changed the `readDomainConfig` signature, only the one-line getter in Task 5.4's `domainConfig()` changes.
  - `authz.bus` stays open (no `propertyNames`), so authz-queue can own `authz.bus.topic`.

## Design decisions

**D1. `@Config` where a DI class reads the value.**
- The property reads the Configuration of the container that built the instance.
- Some classes are built with `new` and handed a container: `DbAuthzAdminBackend` and `DbScopeAttributeStore` through `opts.container`, and `DbLinkStore` through its constructor.
  - Such a class sets `CONFIGURATION_CONTAINER_KEY` to that container in its constructor.
  - It then reads the Configuration that DI would give it in that container.
  - When DI builds the class, autoinject overwrites the key with the resolving container, which is the same container.

**D2. Where `@Config` cannot apply, the read stays and only the checks go.**
- These readers:
  - free functions that take a container: `storeConnection`, `fsAccessConfig`, `fsAccessConfigs`, `fsMetadataConnection`;
  - model `init` reads through `ctx.config(...)`: the rbac `anonymousRoles`, `serviceRoles`, `cacheConfig` and `groupPrincipalConfig`, and abac's `storesFromConfig`;
  - the token rules loader. `tokenRoleExtension` is a factory, not a DI class.
- They keep reading the Configuration they read today. Their checks move to the schema.
- Their code fallbacks stay, because they also run under Configurations that no schema validates:
  - authz-testing's `TestConfiguration`;
  - fake `ModelInitContext`s;
  - `NO_CONFIGURATION`.
- The schema carries the same default, taken from the same exported constant.
- **`ModelInitContext.config` reads stay `ctx.config` reads.**
  - They read `authz.<model.name>.*` of the Configuration that the domain's container resolves, which domains inherit from root.
  - A model instance is shared across domains and DI does not build it, so `@Config` on it would read the wrong container.

**D3. `@Config` readers drop their code defaults.**
- The schema `default` keywords supply the values.
- Some tests run on an unvalidated `TestConfiguration` and relied on those defaults. They now seed the value. Each task lists them.

**D4. Per-entry normalisation stays in code.**
- It compiles a validated entry into its runtime shape:
  - `services[].token`: a string becomes a list, the header is lower-cased, `attributes ?? {}`;
  - roles: a grant string becomes `{ permission }`, `revoke` applies, `extends ?? []`, `assignable ?? true`;
  - rules: `scope ?? GLOBAL`, `expiresAt` becomes a `Date`;
  - fs: `domain ?? 'root'`, a policy without a scope gets its filesystem, `inherit` and `operations` get no prototype;
  - freezing.
- List and map entries also arrive unvalidated, through test seams such as `new ConfigRuleStore(list)` and `parseFsAccessConfig(name, entry)`.
- The inventory adds no default for `authz.rbac.roles`, `ladders` and `rules`, so their absence handling (`?? {}`, `?? []`) stays too.

**D5. Kept in code because a schema cannot express it:**
- DI lookups: the `TokenRolePolicy` class by name, the store classes, the audit service, the existence of an ORM connection.
- Checks against the role graph: config roles exist and are assignable.
- An fs policy scope must be the filesystem its key names. A schema cannot compare a value with its property name.
- The link secret must be present only where `DbLinkStore` is used, which only DI knows.
- abac's throw for an unknown store name. It stays for models named other than `abac`, whose section no schema covers.

**D6. Ajv under the configuration's options:**
- `removeAdditional: true` silently strips keys under `additionalProperties: false`, so unknown keys are refused with `propertyNames: { enum: [...] }`.
- `coerceTypes: true` turns `''` into `null` in a `{ type: 'null' }` branch of an `anyOf`. A nullable name is therefore `{ type: ['string', 'null'], minLength: 1 }`, never an `anyOf` with a null branch.
- Strict mode throws on a `default` inside `anyOf`, `oneOf`, `not` or `if`, so defaults sit on `properties` entries only.
- Negative tests use values that coercion cannot turn valid: objects, arrays, `'yes'`, `''`.

**D7. Schema homes:**

| Keys | Schema | Owner | Registered by |
|---|---|---|---|
| `authz.http.*` | `AUTHZ_HTTP_CONFIGURATION_SCHEMA` | authz-http | `AuthzHttpConfigBootstrapper` (exists) |
| `authz.rbac.*` | `AUTHZ_RBAC_CONFIGURATION_SCHEMA` | authz-rbac | `RbacConfigBootstrapper` (exists) |
| `authz.token.*` | new `AUTHZ_TOKEN_CONFIGURATION_SCHEMA` | authz-rbac, its only reader | `RbacConfigBootstrapper` |
| `authz.abac.*` | new `AUTHZ_ABAC_CONFIGURATION_SCHEMA` | authz-abac, which gets `@spinajs/configuration` as a dependency | new `AbacConfigBootstrapper` |
| `authz.fs.*`, `authz.fsMetadata.*` | new `AUTHZ_FS_CONFIGURATION_SCHEMA`, `AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA` | authz-fs | new `AuthzFsConfigBootstrapper` |
| `authz.orm.*` | new `AUTHZ_ORM_CONFIGURATION_SCHEMA` | authz-orm | new `AuthzOrmConfigBootstrapper` |
| `authz.queue.*`, `authz.bus.topic` | new `AUTHZ_QUEUE_CONFIGURATION_SCHEMA`, `AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA` | authz-queue | new `AuthzQueueConfigBootstrapper` |
| `authz.admin.connection` default | the Phase 4 `admin` block of `AUTHZ_CONFIGURATION_SCHEMA` | authz | Task 5.2 |

No schema file goes under `src/config/`: the configuration loader reads that folder as config fragments.

**D8. The conflicts the inventory names:**
- `groupPrincipal` takes `null` and partial objects. It becomes `type: ['object', 'null']` with `default: {}`, and both fields get defaults from `DEFAULT_GROUP_PRINCIPAL`.
- `authz.admin.connection` gets `default: 'default'` in Task 5.2. Both admin readers drop `?? 'default'`.
- `storeConnection` keeps its fallback across two keys in code: `authz.rbac.connection ?? authz.admin.connection ?? 'default'`. `authz.rbac.connection` gets no schema default, because a default there would hide the admin key.

**D9. The "root `readDomainConfig` calls" of inventory row 2 become merges of `@Config('authz')`.**
- The readers need the domain's merged value. Tests set `authz.domains.<d>.engine`, `.fields` and `.audit`.
- A plain `@Config('authz.engine.explain')` would therefore lose the domain level.
- The classes read `@Config('authz')` and merge it through `readDomainConfig` by lineage. Free functions take the section from their calling class.

## Task order and parallelism

**1. Prelude.** These run in order, before everything else:
- Task 5.1: the test helpers.
- Task 5.2: the `authz.admin.connection` default, and the test configurations that boot without it.

**2. Four groups in parallel.**
- Each group runs in its own worktree.
- Inside a group, the tasks run in order, because they share files, a package suite or a lib.

| Group | Tasks, in order | Why in order |
|---|---|---|
| A (authz-http) | 5.3 → 5.4 → 5.5 | 5.3 and 5.4 both edit `access/policy.ts`. 5.5 uses the `authz.http.admin.domain` schema entry that 5.3 adds. |
| B (authz-rbac, plus users-http) | 5.6 → 5.7 → 5.8 → 5.9 → 5.10 → 5.11 → 5.12 | They share `stores/schema.ts`, `test/stores/config-role-store.test.ts` and the rbac suite. |
| C | 5.13 (authz-abac) → 5.14 (authz-fs) | authz-fs builds `ConfigPolicyStore` and reads the abac lib. |
| D | 5.15 (authz-orm) → 5.16 (authz-queue) | authz-queue reads the authz-orm lib. |

No two groups edit the same file. The test configurations that several groups would touch are all in Task 5.2:
- `users/test/common.test.ts`
- `users-http/test/admin-common.ts`
- `authz-rbac/test/support/db.ts`
- `authz-testing/test/canvas-c6/db.ts`

**3. Integration pass, after groups A to D are merged.**
1. Rebuild each package, mjs then cjs, in this order: `authz` → `authz-testing` → `authz-orm` → `authz-abac` → `authz-rbac` → `authz-http` → `authz-http-admin` → `authz-fs` → `authz-queue` → `users` → `users-http`.
2. Run `npm test` in each of these packages, one at a time:
   - authz, authz-testing, authz-orm, authz-abac, authz-rbac, authz-http, authz-http-admin, authz-fs, authz-queue;
   - users, users-http;
   - telemetry, email, http-socket, queue-http-progress, configuration-http, http-swagger, authz-convert.

## Rows and where `@Config` cannot apply

| Inventory row | Task | `@Config`? |
|---|---|---|
| authz-http `httpConfig()` + 8 callers | 5.3 | Yes, on the 7 caller classes. |
| authz-http `AccessPolicy.trace`, `auditUnscoped`, `decisionFields`, `PrincipalMiddleware` | 5.4 | `@Config('authz')` on the classes. `auditUnscoped` and `decisionFields` are free functions: the calling class passes the section. |
| authz-http-admin `adminDomain` | 5.5 | `adminDomain` is a free function and is deleted. `@Config` goes on `AuthzAdminController`, which calls `domainAdmin(domain)`. |
| authz-rbac `DefaultAdminGuard`, users-http `DefaultAccountGuard` | 5.6 | Yes. |
| `DbAuthzAdminBackend`, `DbScopeAttributeStore` (`authz.admin.connection`) | 5.2 (default), 5.7, 5.15 | Yes, with the container of `opts.container` bound (D1). |
| `storeConnection` | 5.7 | No: a free function over each store's container. The read stays (D2, D8). |
| `ConfigRoleStore` | 5.8 | Yes. The constructor `Configuration` seam stays (global decision 4). |
| `ConfigRuleStore` / `readRuleDefs` / `RULE_SCHEMA` | 5.9 | Yes. The list and `Configuration` seams stay. |
| `DbLinkStore.secret` | 5.10 | Yes. |
| rbac model `anonymousRoles`, `serviceRoles`, `cacheConfig`, `groupPrincipalConfig` | 5.11 | No: they read through `ctx.config` (D2). |
| `tokenRoleExtension` / `loadTokenRoleRules` | 5.12 | No: a factory and a loader over a Configuration (D2). |
| abac `storesFromConfig`, `ConfigPolicyStore` | 5.13 | No: they read through `ctx.config` (D2). |
| authz-fs `fsAccessConfig` + 8 callers, `fsMetadataConnection` | 5.14 | No: free functions over a container (D2). The 8 callers do not change. |
| authz-orm `domainName`, authz-queue `authzFor`, `QueueChangeBus.route` | 5.15, 5.16 | Yes, on `AuthzQueryMiddleware`, `AuthzQueueHook`, `AuthzQueueTrackingHook` and `QueueChangeBus`. |

---

### Task 5.1: authz-testing helpers to boot a schema-checked child Configuration

**Files:**
- Create: `packages/authz-testing/src/host/configuration.ts`
- Modify: `packages/authz-testing/src/host/index.ts:1-4` (one export line)
- Test: `packages/authz-testing/test/configuration.test.ts` (new)

**Interfaces:**
- Consumes from Phase 0:
  - `FrameworkConfiguration` validation with the schemas of the lineage;
  - `InvalidConfiguration.violations`;
  - `CONFIGURATION_CONTAINER_KEY`.
- Produces, exported from `@spinajs/authz-testing`:
  - `configurationOf(values): Class<Configuration>`;
  - `bootConfiguration(values, schemas?, parent?): Promise<{ child, configuration }>`;
  - `violationPaths(boot): Promise<string[]>`;
  - `bindConfiguration(instance, container): instance`.
- Every later task uses these helpers.

- [ ] **Step 1: Schema additions**

None.

- [ ] **Step 2: Failing tests**

`packages/authz-testing/test/configuration.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { Config } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { bindConfiguration, bootConfiguration, violationPaths } from '../src/index.js';

const SCHEMA = {
  $id: 'spinajs/authz-testing.probe.schema.json',
  $configurationModule: 'probe',
  type: 'object',
  properties: {
    size: { type: 'integer', minimum: 1, default: 3 },
    name: { type: 'string', minLength: 1 },
  },
};

class Probe {
  @Config('probe.size')
  public Size: number;
}

describe('authz-testing configuration helpers', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('bootConfiguration validates the values with the schemas and fills their defaults', async () => {
    const { child, configuration } = await bootConfiguration({ probe: { name: 'a' } }, [SCHEMA]);
    children.push(child);

    expect(configuration.get('probe')).to.deep.equal({ name: 'a', size: 3 });
  });

  it('violationPaths gives the full path of every refused value', async () => {
    expect(await violationPaths(bootConfiguration({ probe: { size: 0, name: '' } }, [SCHEMA]))).to.include.members(['probe.size', 'probe.name']);
  });

  it('violationPaths fails when the boot succeeds', async () => {
    const error = await violationPaths(bootConfiguration({ probe: {} }, [SCHEMA])).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).to.be.instanceOf(Error).with.property('message').that.contains('booted');
  });

  it('bindConfiguration points the @Config properties of an instance built with new at a container', async () => {
    const { child } = await bootConfiguration({ probe: { size: 7 } }, [SCHEMA]);
    children.push(child);

    expect(bindConfiguration(new Probe(), child).Size).to.equal(7);
  });
});
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-testing && npx ts-mocha -p tsconfig.json test/configuration.test.ts`

Expected: the file fails to compile with `TS2305: Module '"../src/index.js"' has no exported member 'bindConfiguration'`. The same error is reported for `bootConfiguration` and `violationPaths`.

- [ ] **Step 4: Implement**

`packages/authz-testing/src/host/configuration.ts`:

```ts
import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import type { IConfigurationSchema } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

/** A FrameworkConfiguration over `values` alone: no file or env source, so only the schemas validate and default it. */
export function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SchemaTestConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

export interface BootedConfiguration {
  /** A child of the parent that holds the Configuration; the caller disposes it. */
  readonly child: IContainer;
  readonly configuration: Configuration;
}

/**
 * `values` as the resolved Configuration of a fresh child of `parent`, with `schemas` registered there; the schemas of
 * the lineage apply too. Rejects with InvalidConfiguration, after disposing the child, for a value they refuse.
 */
export async function bootConfiguration(values: Record<string, unknown>, schemas: readonly IConfigurationSchema[] = [], parent: IContainer = DI.RootContainer): Promise<BootedConfiguration> {
  const child = parent.child();
  for (const schema of schemas) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values)).as(Configuration);
  try {
    return { child, configuration: (await child.resolve(Configuration)) as Configuration };
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

/** The `violations[].path` of the InvalidConfiguration that `boot` rejects with; any other outcome fails. */
export async function violationPaths(boot: Promise<unknown>): Promise<string[]> {
  let booted: unknown;
  try {
    booted = await boot;
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
  await (booted as Partial<BootedConfiguration> | undefined)?.child?.dispose();
  throw new Error('expected the configuration boot to fail with InvalidConfiguration, but it booted');
}

/** Makes the @Config properties of `instance`, built with `new`, read the Configuration of `container`. */
export function bindConfiguration<T extends object>(instance: T, container: IContainer): T {
  (instance as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = container;
  return instance;
}
```

In `packages/authz-testing/src/host/index.ts`, after `export { hostHarness } from './harness.js';`, add:

```ts
export * from './configuration.js';
```

- [ ] **Step 5: GREEN + package suite**

```bash
cd packages/authz-testing
npx ts-mocha -p tsconfig.json test/configuration.test.ts   # 4 passing
npm test                                                   # all passing
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
```

- No dependant suite needs to run: the change only adds exports.
- Every later task reads the rebuilt lib.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-testing/src/host/configuration.ts packages/authz-testing/src/host/index.ts packages/authz-testing/test/configuration.test.ts
git commit -m "test(authz-testing): boot a schema-checked child Configuration and bind @Config of instances built with new"
```

---

### Task 5.2: `authz.admin.connection` defaults to the default ORM connection

**Files:**
- Modify: `packages/authz/src/host/config/schema.ts`, the `admin` block that Phase 4 added.
- Test: `packages/authz/test/host/admin-connection.test.ts` (new).
- Modify these test configurations, which boot without the core schema:
  - `packages/authz-rbac/test/support/db.ts:1-3,123-126`
  - `packages/authz-testing/test/canvas-c6/db.ts:1-11,42-47`
  - `packages/users/test/common.test.ts` (the `authz.admin` block, near line 217)
  - `packages/users-http/test/admin-common.ts` (the `authz.admin` block, near line 140)

**Interfaces:**
- Consumes:
  - the Task 5.1 helpers;
  - the Phase 4 `admin` block.
- Produces: in a validated configuration, `authz.admin.connection` is always a non-empty string, `'default'` unless set. Tasks 5.7 and 5.15 drop their `?? 'default'`.

- [ ] **Step 1: Schema additions**

In `AUTHZ_CONFIGURATION_SCHEMA.properties.admin` (Phase 4):
1. Add `default: {}` next to its `type: 'object'`, unless Phase 4 already set it. An unset `authz.admin` then still gets its nested defaults.
2. Set its `connection` entry to exactly:

```ts
        connection: { type: 'string', minLength: 1, default: 'default' },
```

- [ ] **Step 2: Failing tests**

`packages/authz/test/host/admin-connection.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

describe('authz.admin.connection', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>) {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  it('is the default ORM connection when the app names none', async () => {
    expect((await boot({})).get('authz.admin.connection')).to.equal('default');
    expect((await boot({ admin: { maxBatch: 5 } })).get('authz.admin.connection')).to.equal('default');
  });

  it('keeps a named connection', async () => {
    expect((await boot({ admin: { connection: 'authz' } })).get('authz.admin.connection')).to.equal('authz');
  });

  it('refuses an empty name at boot', async () => {
    expect(await violationPaths(boot({ admin: { connection: '' } }))).to.include('authz.admin.connection');
  });
});
```

- [ ] **Step 3: RED**

The authz tests import the lib, so compile it before the run:

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json
npx ts-mocha -p tsconfig.json --config .mocharc.host.json test/host/admin-connection.test.ts
```

Expected: FAIL at "is the default ORM connection…", with `expected undefined to equal 'default'`.

- [ ] **Step 4: Implement**

1. Apply Step 1.
2. In `packages/authz-rbac/test/support/db.ts`:
   1. Add `import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';`.
   2. In `bootDb`, before `container.register(configurationFor(connection, second)).as(Configuration);`, add:

```ts
  // The test database boots as an app does: the core schema gives authz.admin.connection its default.
  container.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
```

3. In `packages/authz-testing/test/canvas-c6/db.ts`:
   1. Import `AUTHZ_CONFIGURATION_SCHEMA` from `'@spinajs/authz'`.
   2. In `bootCanvasDb`, before `container.register(CanvasDbConfiguration).as(Configuration);`, add the same two lines as in item 2.
4. In both `packages/users/test/common.test.ts` and `packages/users-http/test/admin-common.ts`, in the `authz.admin` block, after `backend: 'DbAuthzAdminBackend',`, add:

```ts
          // These suites may resolve their Configuration before authz's bootstrapper registers the core schema.
          connection: 'default',
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json
npx ts-mocha -p tsconfig.json --config .mocharc.host.json test/host/admin-connection.test.ts   # 3 passing
npm test
npx tsc -b tsconfig.cjs.json
cd ../authz-testing && npm test
cd ../authz-orm && npm test
cd ../authz-rbac && npm test
cd ../users && npm test
cd ../users-http && npm test
```

Expected: all passing. The default only adds a value that the readers already assumed.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host/config/schema.ts packages/authz/test/host/admin-connection.test.ts packages/authz-rbac/test/support/db.ts packages/authz-testing/test/canvas-c6/db.ts packages/users/test/common.test.ts packages/users-http/test/admin-common.ts
git commit -m "feat(authz): authz.admin.connection defaults to the default ORM connection in the schema"
```

---

### Task 5.3: authz-http `authz.http.*` through `@Config`; `httpConfig()` deleted

**Files:**
- Modify: `packages/authz-http/src/http-config.ts:1-109` (whole file)
- Modify: `packages/authz-http/src/access/policy.ts:2,10,141-159`
- Modify: `packages/authz-http/src/controllers/AccessController.ts:8,41-56`
- Modify: `packages/authz-http/src/explain/controller.ts:1-9,23-60`
- Modify: `packages/authz-http/src/explain/source.ts:1-32`
- Modify: `packages/authz-http/src/principals/link-source.ts:1-8,39-75`
- Modify: `packages/authz-http/src/principals/service-source.ts:1-46`
- Test (new): `packages/authz-http/test/config.test.ts`
- Test (modify): `packages/authz-http/test/service-source.test.ts:3,7,30,69,73-78` and `packages/authz-http/test/link-source.test.ts:56`
- Dependant test config: `packages/telemetry/test/common.ts`, the `authz:` line of `testConfig()`. Telemetry's in-memory configuration applies no schema defaults.

**Interfaces:**
- Consumes: the Task 5.1 helpers.
- Produces:
  - `AUTHZ_HTTP_CONFIGURATION_SCHEMA` with defaults for every key, plus `admin.domain`. Task 5.5 uses `admin.domain`.
  - `ServiceEntry`.
  - `servicePrincipals(entries)`.
  - `AuthzHttpConfig`, now the validated shape.
- Removes `httpConfig()`.

- [ ] **Step 1: Schema additions**

These go in `AUTHZ_HTTP_CONFIGURATION_SCHEMA`. The full file is in Step 4.

Defaults (from the inventory, plus what completes their blocks):
- `services: []`
- `explainRoute`:
  - `default: {}`
  - `enabled: false`
  - `permission: 'authz:explain'`
- `links`:
  - `default: {}`
  - `query: 'link'`
  - `header: 'X-Authz-Link'`
  - `cookie: null`
- `access`:
  - `default: {}`
  - `domain: 'root'`

New block: `admin: { type: 'object', default: {}, properties: { domain: { type: 'string', minLength: 1, default: 'root' } } }`.

A nullable link name becomes `{ type: ['string', 'null'], minLength: 1 }` (D6).

- [ ] **Step 2: Failing tests**

`packages/authz-http/test/config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';

import { AUTHZ_HTTP_CONFIGURATION_SCHEMA, LinkPrincipalSource, ServicePrincipalSource } from '../src/index.js';

const request = (headers: Record<string, string>, query: Record<string, string> = {}) => ({ headers, query, storage: {} }) as unknown as Request;

describe('authz.http through @Config and its schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(http: unknown) {
    const booted = await bootConfiguration({ authz: { http } }, [AUTHZ_HTTP_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted;
  }

  const refused = (http: unknown) => violationPaths(boot(http));

  it('fills every default of an unset authz.http', async () => {
    const { configuration } = await boot(undefined);

    expect(configuration.get('authz.http')).to.deep.equal({
      services: [],
      explainRoute: { enabled: false, permission: 'authz:explain' },
      links: { query: 'link', header: 'X-Authz-Link', cookie: null },
      access: { domain: 'root' },
      admin: { domain: 'root' },
    });
  });

  it('keeps a configured value next to the defaults of its block', async () => {
    const { configuration } = await boot({ links: { cookie: 'share' }, access: { domain: 'fs' } });

    expect(configuration.get('authz.http.links')).to.deep.equal({ query: 'link', header: 'X-Authz-Link', cookie: 'share' });
    expect(configuration.get('authz.http.access.domain')).to.equal('fs');
  });

  it('refuses a malformed value at boot, naming its full path', async () => {
    expect(await refused({ admin: { domain: '' } })).to.include('authz.http.admin.domain');
    expect(await refused({ links: { query: '' } })).to.include('authz.http.links.query');
    expect(await refused({ services: [{ header: 'X', token: 't' }] })).to.include('authz.http.services.0.name');
    expect(await refused({ services: [{ name: 'a', token: 't' }] })).to.include('authz.http.services.0.header');
    expect(await refused({ services: [{ name: 'a', header: 'X', token: '' }] })).to.include('authz.http.services.0.token');
    expect(await refused({ services: [{ name: 'a', header: 'X', token: [] }] })).to.include('authz.http.services.0.token');
    expect(await refused({ services: [{ name: 'a', header: 'X', token: 't', attributes: 1 }] })).to.include('authz.http.services.0.attributes');
    expect(await refused({ services: 'x' })).to.include('authz.http.services');
    expect(await refused({ explainRoute: { enabled: 'yes' } })).to.include('authz.http.explainRoute.enabled');
    expect(await refused({ explainRoute: { permission: '' } })).to.include('authz.http.explainRoute.permission');
    expect(await refused({ access: { domain: '' } })).to.include('authz.http.access.domain');
  });

  it('ServicePrincipalSource reads the services of the Configuration its container resolves', async () => {
    const { child } = await boot({ services: [{ name: 'telemetry', header: 'X-Telemetry-Token', token: 's3cret' }] });
    const source = bindConfiguration(new ServicePrincipalSource(), child);

    expect(await source.authenticate(request({ 'x-telemetry-token': 's3cret' }))).to.deep.include({ type: 'service', id: 'telemetry' });
  });

  it('LinkPrincipalSource reads the link names of the Configuration its container resolves', async () => {
    const { child } = await boot({ links: { query: 'share' } });
    const source = bindConfiguration(new LinkPrincipalSource(), child) as unknown as { token(req: Request): string | undefined };

    expect(source.token(request({}, { share: 't1', link: 't2' }))).to.equal('t1');
  });
});
```

Edits to `packages/authz-http/test/service-source.test.ts`:
1. Line 3: delete `import { AuthzConfigError } from '@spinajs/authz';`.
2. Line 7: change the import to `import { AUTHZ_HTTP_CONFIGURATION_SCHEMA, ServicePrincipalSource } from '../src/index.js';`.
3. Line 30: replace `afterEach(() => testHost.config().unset(['authz', 'http', 'services']));` with `beforeEach(() => configure([]));`. The default list is `[]`, and the in-memory configuration applies no schema.
4. Line 69: rename the test `'yields nothing without authz.http.services'` to `'yields nothing while no service is configured'`.
5. Delete the test `'refuses a malformed entry with AuthzConfigError'` (lines 73-78). `config.test.ts` covers these values at boot.

Edit to `packages/authz-http/test/link-source.test.ts:56`. Replace:

```ts
  afterEach(() => testHost.config().unset(['authz', 'http', 'links']));
```

with:

```ts
  // Back to the schema defaults: the in-memory test configuration applies no schema.
  afterEach(() => testHost.config().set(['authz', 'http', 'links'], { query: 'link', header: 'X-Authz-Link', cookie: null }));
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/config.test.ts`

Expected: 4 failing.
- "fills every default": actual `{}`.
- "refuses a malformed value": `expected the configuration boot to fail with InvalidConfiguration, but it booted` for `admin.domain`.
- ServicePrincipalSource: `null`, because `httpConfig()` reads the root Configuration.
- LinkPrincipalSource: `'t2'`.

"keeps a configured value" passes.

- [ ] **Step 4: Implement**

`packages/authz-http/src/http-config.ts` (whole file):

```ts
import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';

/** One `authz.http.services` entry as configured. */
export interface ServiceEntry {
  readonly name: string;
  readonly header: string;
  /** Several for rotation. */
  readonly token: string | readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** A service entry as ServicePrincipalSource matches it. */
export interface ServicePrincipalConfig {
  readonly name: string;
  /** Lower-cased: node lower-cases the names of `req.headers`. */
  readonly header: string;
  readonly tokens: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface LinksConfig {
  readonly query: string | null;
  readonly header: string | null;
  readonly cookie: string | null;
}

/** `authz.http.*` as AUTHZ_HTTP_CONFIGURATION_SCHEMA leaves it: every key set. */
export interface AuthzHttpConfig {
  readonly services: readonly ServiceEntry[];
  readonly explainRoute: { readonly enabled: boolean; readonly permission: string };
  readonly links: LinksConfig;
  /** The domain GET /user/access and POST /user/access/check answer for. */
  readonly access: { readonly domain: string };
  /** The domain whose AuthzAdmin the authz-http-admin routes use. */
  readonly admin: { readonly domain: string };
}

const nonEmpty = { type: 'string', minLength: 1 };
// One type list, not an anyOf with a null branch: coerceTypes would turn '' into null there and accept it.
const nullableName = { type: ['string', 'null'], minLength: 1 };

export const AUTHZ_HTTP_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-http.configuration.schema.json',
  $configurationModule: 'authz.http',
  description: 'HTTP authorization configuration (authz.http.*)',
  type: 'object',
  properties: {
    services: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        required: ['name', 'header', 'token'],
        properties: {
          name: nonEmpty,
          header: nonEmpty,
          token: { anyOf: [nonEmpty, { type: 'array', minItems: 1, items: nonEmpty }] },
          attributes: { type: 'object' },
        },
      },
    },
    explainRoute: {
      type: 'object',
      default: {},
      properties: { enabled: { type: 'boolean', default: false }, permission: { ...nonEmpty, default: 'authz:explain' } },
    },
    links: {
      type: 'object',
      default: {},
      properties: { query: { ...nullableName, default: 'link' }, header: { ...nullableName, default: 'X-Authz-Link' }, cookie: { ...nullableName, default: null } },
    },
    access: { type: 'object', default: {}, properties: { domain: { ...nonEmpty, default: 'root' } } },
    admin: { type: 'object', default: {}, properties: { domain: { ...nonEmpty, default: 'root' } } },
  },
};

@Injectable(Bootstrapper)
export class AuthzHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_HTTP_CONFIGURATION_SCHEMA);
  }
}

/** The configured services as ServicePrincipalSource matches them. */
export function servicePrincipals(services: readonly ServiceEntry[]): ServicePrincipalConfig[] {
  return services.map((s) => ({
    name: s.name,
    header: s.header.toLowerCase(),
    tokens: typeof s.token === 'string' ? [s.token] : s.token,
    attributes: Object.freeze({ ...(s.attributes ?? {}) }),
  }));
}
```

Deleted from the file:
- `isRecord`
- `isName`
- `fail`
- `service`
- `optionalName`
- `httpConfig`

`packages/authz-http/src/access/policy.ts`:
1. Line 2 becomes `import { Config, Configuration } from '@spinajs/configuration';`. Task 5.4 removes `Configuration`.
2. Delete line 10, `import { httpConfig } from '../http-config.js';`.
3. In `AccessPolicy`, before the constructor, add:

```ts
  @Config('authz.http.explainRoute.permission')
  protected ExplainPermission: Permission;
```

4. Line 153 becomes `const permission = this.ExplainPermission;`.

`packages/authz-http/src/controllers/AccessController.ts`:
1. Replace line 8 with `import { Config } from '@spinajs/configuration';`.
2. Change the class as follows. The rest of the file stays.

```ts
@BasePath('user/access')
export class AccessController extends BaseController {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Get('/')
  @Policy(HasPrincipal)
  public async summary(@Req() req: Request) {
    const authz = await domainService(this.AccessDomain);
    return new Ok(await authz.summary(req.storage.Principal!));
  }

  @Post('check')
  @Policy(IsAuthenticated)
  public async check(@Req() req: Request, @Body() checks: unknown[]) {
    const list = readChecks(checks);
    const authz = await domainService(this.AccessDomain);
```

`packages/authz-http/src/explain/controller.ts`:
1. Replace line 8 with `import { Config } from '@spinajs/configuration';`.
2. Line 2 becomes `import type { Permission, Principal, ResourceRef } from '@spinajs/authz';`.
3. Change the two classes as follows:

```ts
/** Allows a caller who holds `authz.http.explainRoute.permission` in the access domain. */
export class ExplainPolicy extends BasePolicy {
  @Config('authz.http.access.domain')
  protected AccessDomain: string;

  @Config('authz.http.explainRoute.permission')
  protected ExplainPermission: Permission;

  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const principal = req.storage.Principal;
    if (!principal?.authenticated) throw unauthenticated('the explain route needs an authenticated principal');

    const authz = await domainService(this.AccessDomain);
    const permission = this.ExplainPermission;
    const decision = await authz.check({ principal, permission, resource: { type: parsePermission(permission).resource } });
    // Only an unconditional grant: nothing here would enforce a residual.
    if (!decision.allowed || decision.residual.op !== 'true') throw forbidden(decision);
  }
}
```

In `ExplainController`:
1. Add `@Config('authz.http.access.domain') protected AccessDomain: string;` above `@Get('explain')`.
2. Its line `const authz = await domainService(httpConfig().access.domain);` becomes `const authz = await domainService(this.AccessDomain);`.

`packages/authz-http/src/explain/source.ts`:
1. Replace line 7 with `import { Config } from '@spinajs/configuration';`.
2. In `ExplainControllerSource`, after the `Log` property, add:

```ts
  @Config('authz.http.explainRoute.enabled')
  protected ExplainEnabled: boolean;
```

3. Change `if (!httpConfig().explainRoute.enabled) return [];` to `if (!this.ExplainEnabled) return [];`.

`packages/authz-http/src/principals/link-source.ts`:
1. Replace line 7 with these two imports:

```ts
import { Config } from '@spinajs/configuration';
import type { LinksConfig } from '../http-config.js';
```

2. In `LinkPrincipalSource`, after the `Log` property, add:

```ts
  @Config('authz.http.links')
  protected Links: LinksConfig;
```

3. In `token()`, change `const { query, header, cookie } = httpConfig().links;` to `const { query, header, cookie } = this.Links;`.

`packages/authz-http/src/principals/service-source.ts` (whole file):

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';

import { PrincipalSource } from '../api.js';
import { servicePrincipals } from '../http-config.js';
import type { ServiceEntry, ServicePrincipalConfig } from '../http-config.js';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

// Equal-length digests, so neither the token's length nor its first differing byte shows in the timing.
const sameToken = (presented: string, expected: string) => timingSafeEqual(digest(presented), digest(expected));

function servicePrincipal(s: ServicePrincipalConfig): Principal {
  return Object.freeze({ type: 'service', id: s.name, authenticated: true, source: 'service', attributes: s.attributes });
}

/**
 * `service:<name>` for a request whose configured header carries one of the service's tokens
 * (`authz.http.services`, design §11.1). Runs before the authn principal (order 40 < 50), so a
 * configured service header wins over any authn credential. A wrong token yields nothing: the
 * header may be one other credentials share.
 */
@Injectable(PrincipalSource)
export class ServicePrincipalSource extends PrincipalSource {
  public readonly name = 'service';
  public readonly order = 40;

  @Config('authz.http.services')
  protected Services: readonly ServiceEntry[];

  public async authenticate(req: Request): Promise<Principal | null> {
    for (const service of servicePrincipals(this.Services)) {
      const presented = req.headers?.[service.header];
      if (typeof presented !== 'string' || presented.length === 0) {
        continue;
      }

      // Every token is compared, matched or not.
      const matches = service.tokens.map((t) => sameToken(presented, t));
      if (matches.includes(true)) {
        return servicePrincipal(service);
      }
    }

    return null;
  }
}
```

`packages/telemetry/test/common.ts`, in `testConfig()`. Replace:

```ts
    // As an app merges the telemetry config fragment.
    authz: structuredClone(fragment.authz),
```

with:

```ts
    // As an app merges the telemetry and authz-http config fragments; this in-memory configuration applies no schema defaults.
    authz: {
      ...structuredClone(fragment.authz),
      http: { services: [], explainRoute: { enabled: false, permission: 'authz:explain' }, links: { query: 'link', header: 'X-Authz-Link', cookie: null }, access: { domain: 'root' }, admin: { domain: 'root' } },
      principals: { anonymous: { enabled: true } },
    },
```

`principals` is needed from Task 5.4 on. It is added here so that telemetry is edited once.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-http
npx ts-mocha -p tsconfig.json test/config.test.ts test/service-source.test.ts test/link-source.test.ts test/explain.test.ts test/access-controller.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../authz-http-admin && npm test
cd ../configuration-http && npm test
cd ../http-swagger && npm test
cd ../queue-http-progress && npm test
cd ../telemetry && npm test
```

Expected: all passing.
- authz-http's `startApp`, and those of configuration-http and queue-http-progress, seed from a `DefaultsConfiguration` that runs the bootstrappers, so the schema defaults are present.
- telemetry has its own seed (Step 4).

- [ ] **Step 6: Commit**

```bash
git add packages/authz-http/src packages/authz-http/test/config.test.ts packages/authz-http/test/service-source.test.ts packages/authz-http/test/link-source.test.ts packages/telemetry/test/common.ts
git commit -m "refactor(authz-http): authz.http through @Config and its schema defaults, httpConfig removed"
```

---

### Task 5.4: authz-http reads the `authz` section through `@Config` and merges it by domain lineage

**Files:**
- Modify: `packages/authz-http/src/domains.ts:1-41` (whole file)
- Modify: `packages/authz-http/src/fields.ts:1-3,24-41,69-80,98-133`
- Modify: `packages/authz-http/src/access/policy.ts:2-3,9,141-159`
- Modify: `packages/authz-http/src/access/decorators.ts:1-15,90-118`
- Modify: `packages/authz-http/src/principals/middleware.ts:1-3,99-137`
- Test (new): `packages/authz-http/test/domain-config.test.ts`
- Test (modify): `packages/authz-http/test/access-controller.test.ts:64`, `test/access.test.ts:268`, `test/extractors.test.ts:106`, `test/principals.test.ts:170`

**Interfaces:**
- Consumes:
  - Phase 4: `readDomainConfig`, `ConfigGetter`, `DomainConfig`, `AUTHZ_DEFAULTS`, and the default `principals.anonymous.enabled: true`;
  - Task 5.1.
- Produces:
  - `domainConfig(authz, domains, domain): DomainConfig`.
  - `decisionFields(authz, decision, domain?)`: the `authz` section is the new first parameter.
  - `auditUnscoped(authz, domain, entry)`: same.
- No `DI.get(Configuration)` is left in authz-http.

- [ ] **Step 1: Schema additions**

None (inventory). The keys are covered by `AUTHZ_CONFIGURATION_SCHEMA`, with the Phase 4 defaults.

- [ ] **Step 2: Failing tests**

`packages/authz-http/test/domain-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, subtractFieldGlobs } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, testHost, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { PrincipalMiddleware, decisionFields } from '../src/index.js';

describe('authz-http reads the authz section through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const anonymousOf = (child: IContainer) => (bindConfiguration(new PrincipalMiddleware(), child) as unknown as { AnonymousEnabled: boolean }).AnonymousEnabled;

  it('PrincipalMiddleware reads authz.principals.anonymous.enabled of its container, on by default', async () => {
    expect(anonymousOf(await boot({ principals: { anonymous: { enabled: false } } }))).to.equal(false);
    expect(anonymousOf(await boot({}))).to.equal(true);
  });

  it('refuses a malformed authz.principals.anonymous.enabled at boot', async () => {
    expect(await violationPaths(boot({ principals: { anonymous: { enabled: 'yes' } } }))).to.include('authz.principals.anonymous.enabled');
  });

  describe('with the host domains', () => {
    before(async () => {
      await testHost.installHost();
      await testHost.domains();
    });

    after(() => testHost.uninstallHost());

    it('decisionFields merges the authz section it is given over the domain lineage', () => {
      const fields = decisionFields({ fields: { neverRead: ['Secret'], write: { mode: 'reject' } } }, undefined, 'root');

      expect(fields.writeMode).to.equal('reject');
      expect(fields.read).to.deep.equal(subtractFieldGlobs(['*'], ['Secret']));
    });
  });
});
```

Edits to the four tests that turn the anonymous principal off and back on:
- Files and lines: `access-controller.test.ts:64`, `access.test.ts:268`, `extractors.test.ts:106`, `principals.test.ts:170`.
- The in-memory test configuration applies no schema, so the `finally` restores the value instead of removing it.
- In each file, replace

```ts
testHost.config().unset(['authz', 'principals', 'anonymous', 'enabled']);
```

with

```ts
testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-http && npx ts-mocha -p tsconfig.json test/domain-config.test.ts`

Expected: the file fails to compile with `TS2554: Expected 1-2 arguments, but got 3` at `decisionFields(...)`.

If you temporarily comment out that test, the PrincipalMiddleware test fails with `expected undefined to equal false`: the property does not exist yet.

- [ ] **Step 4: Implement**

`packages/authz-http/src/domains.ts` (whole file):

```ts
import { DI, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { AuthzConfigError, AuthzDomains, AuthzService, DecisionAudit, DefaultAuthzDomains, readDomainConfig } from '@spinajs/authz';
import type { ConfigGetter, DomainConfig } from '@spinajs/authz';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The booted AuthzService of a domain; `authz()` would throw before the domain's first resolve. */
export async function domainService(domain: string): Promise<AuthzService> {
  if (domain === 'root') {
    return (await DI.resolve(AuthzService)) as AuthzService;
  }
  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return domains.service(domain);
}

/** `domain`'s configuration merged over its lineage as the host merges it, from `authz`, the caller's `authz` section. */
export function domainConfig(authz: unknown, domains: DefaultAuthzDomains, domain: string): DomainConfig {
  const read: ConfigGetter = ([root, ...path]) => (root === 'authz' ? path.reduce<unknown>((cur, seg) => (isRecord(cur) && Object.hasOwn(cur, seg) ? cur[seg] : undefined), authz) : undefined);
  return readDomainConfig(read, domains.lineage(domain));
}

type AuditEntry = Parameters<DecisionAudit['record']>[0];

// Mirrors how the host picks a domain's DecisionAudit (authz.audit.service, else the registered one).
async function pickAudit(container: IContainer, service: string | undefined): Promise<DecisionAudit | undefined> {
  if (service === undefined) {
    return container.hasRegistered(DecisionAudit) ? ((await container.resolve(DecisionAudit)) as DecisionAudit) : undefined;
  }
  const entry = container.Registry.getTypesChain(DecisionAudit)
    .filter((e) => !isFactory(e.type) && (e.type as Class<unknown>).name === service)
    .pop();
  return entry ? ((await entry.container.resolve(entry.type as Class<DecisionAudit>)) as DecisionAudit) : undefined;
}

/**
 * Records an `unscoped` bypass with the domain's DecisionAudit when the domain's `audit.unscoped`
 * is on. The host keeps its audit to itself, so this merges the same `authz` section.
 */
export async function auditUnscoped(authz: unknown, domain: string, entry: AuditEntry): Promise<void> {
  const domains = await DI.resolve(AuthzDomains);
  // A bypass must not go unaudited, and only the host's AuthzDomains tells a domain's config lineage.
  if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError('@Unscoped needs the host AuthzDomains to audit the bypass');
  const cfg = domainConfig(authz, domains, domain);
  if (!cfg.audit.unscoped) return;
  const audit = await pickAudit(domains.container(domain), cfg.audit.service);
  await audit?.record(entry);
}
```

`packages/authz-http/src/fields.ts`:

1. Imports, lines 1-3. Add the import of `../domains.js` after the import of `./storage.js`.

```ts
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_DEFAULTS, AuthzDomains, DefaultAuthzDomains, authzStorage, compileFieldGlobs, filterObject, subtractFieldGlobs } from '@spinajs/authz';
```

```ts
import { domainConfig } from './domains.js';
```

2. `decisionFields`. The first line of its doc stays. Append: "`authz` is the `authz` section its caller reads through @Config."

```ts
export function decisionFields(authz: unknown, decision: Decision | undefined, domain: string = decision?.domain ?? 'root'): DecisionFields {
  const domains = DI.get(AuthzDomains);
  let neverRead: readonly string[] = AUTHZ_DEFAULTS.fields.neverRead;
  let writeMode: 'strip' | 'reject' = AUTHZ_DEFAULTS.fields.write.mode;
  if (domains instanceof DefaultAuthzDomains) {
    const cfg = domainConfig(authz, domains, domain);
    neverRead = cfg.fields.neverRead;
    writeMode = cfg.fields.writeMode;
  }
  const without = (globs: readonly string[]) => (neverRead.length === 0 ? globs : subtractFieldGlobs(globs, neverRead));
  return { read: without(decision?.fields.read ?? ['*']), write: without(decision?.fields.write ?? ['*']), writeMode };
}
```

3. `AuthzInputFieldFilter`:
   1. Add the property:

```ts
  @Config('authz')
  protected Authz: unknown;
```

   2. In `filter`, the call becomes `const { write, writeMode } = decisionFields(this.Authz, decision, decision?.domain ?? mark?.domain);`.

4. `readable`, `AuthzFieldTransformer` and `AuthzFieldsMiddleware`:

```ts
function readable(authz: unknown, data: unknown, decision: Decision | undefined, domain: string | undefined): unknown {
  if ((!decision && domain === undefined) || !isObject(data)) return data;
  return filterObject(decisionFields(authz, decision, decision?.domain ?? domain).read, data);
}

/** `x-data-transform: authz-fields`: the response data limited to what the route's decision lets the caller read. */
@Injectable(DataTransformer)
export class AuthzFieldTransformer extends DataTransformer {
  @Config('authz')
  protected Authz: unknown;

  public get Type(): string {
    return 'authz-fields';
  }

  public transform(data: unknown, request: express.Request): unknown {
    const storage = (request as Request).storage;
    return readable(this.Authz, data, storage?.AuthzDecision, (storage?.AuthzHttpRoute as AuthzHttpRouteMark | undefined)?.domain);
  }
}

/** Added by `@Access(…, { fields: 'filter' })`: the response data limited to `decision.fields.read` (B17). */
@NewInstance()
export class AuthzFieldsMiddleware extends RouteMiddleware {
  @Config('authz')
  protected Authz: unknown;

  public isEnabled(route: IRoute, controller: IController): boolean {
    const access = routeAccess(controller, route.Method);
    return (access.route ?? access.controller)?.options.fields === 'filter';
  }

  public async onBefore(): Promise<void> {}

  // http calls this without awaiting it, so the data is replaced before the first await.
  public async onResponse(response: Response, route: IRoute, controller: IController): Promise<void> {
    const decision = authzStorage().getStore()?.AuthzDecision;
    const domain = routeDomain(routeAccess(controller, route.Method));
    const authz = this.Authz;
    const holder = response as unknown as { responseData?: unknown };
    const data = holder.responseData;
    holder.responseData = Promise.all(Array.isArray(data) ? data : [data]).then((resolved) => readable(authz, Array.isArray(data) ? resolved : resolved[0], decision, domain));
  }

  public async onAfter(): Promise<void> {}
}
```

`packages/authz-http/src/access/policy.ts`:
1. Line 2 becomes `import { Config } from '@spinajs/configuration';`.
2. Remove `readDomainConfig` from the line 3 import.
3. Line 9 becomes `import { domainConfig, domainService } from '../domains.js';`.
4. In `AccessPolicy`, next to `ExplainPermission`, add:

```ts
  @Config('authz')
  protected Authz: unknown;
```

5. In `trace`, replace

```ts
    const configuration = DI.get(Configuration);
    if (!readDomainConfig((path) => configuration?.get(path), domains.lineage(domain)).engine.explain) return undefined;
```

with

```ts
    if (!domainConfig(this.Authz, domains, domain).engine.explain) return undefined;
```

`packages/authz-http/src/access/decorators.ts`:
1. After line 1, add `import { Config } from '@spinajs/configuration';`.
2. In `UnscopedMiddleware`:
   1. Before the constructor, add:

```ts
  @Config('authz')
  protected Authz: unknown;
```

   2. In `onBefore`, the call becomes `await auditUnscoped(this.Authz, routeDomain(routeAccess(controller, route.Method)), {`. The rest of the call stays.

`packages/authz-http/src/principals/middleware.ts`:
1. Line 2 becomes `import { Config } from '@spinajs/configuration';`.
2. In `PrincipalMiddleware`, after the `Log` property, add:

```ts
  @Config('authz.principals.anonymous.enabled')
  protected AnonymousEnabled: boolean;
```

3. Line 117 becomes `return principal ?? (this.AnonymousEnabled ? ANONYMOUS : null);`.
4. Delete the `anonymousEnabled()` method (lines 134-137).

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-http
npx ts-mocha -p tsconfig.json test/domain-config.test.ts test/access-policy.test.ts test/access.test.ts test/fields.test.ts test/principals.test.ts test/access-controller.test.ts test/extractors.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../authz-http-admin && npm test
cd ../configuration-http && npm test
cd ../http-swagger && npm test
cd ../queue-http-progress && npm test
cd ../telemetry && npm test
```

Expected: all passing. The `startApp` seeds carry `principals.anonymous.enabled: true` from the core schema default. telemetry carries it from Task 5.3.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-http/src packages/authz-http/test/domain-config.test.ts packages/authz-http/test/access-controller.test.ts packages/authz-http/test/access.test.ts packages/authz-http/test/extractors.test.ts packages/authz-http/test/principals.test.ts
git commit -m "refactor(authz-http): the authz section through @Config, merged by domain lineage, no root Configuration reads"
```

---

### Task 5.5: authz-http-admin `authz.http.admin.domain` through `@Config`

**Files:**
- Modify: `packages/authz-http-admin/src/routes/domain.ts:1-21` (whole file)
- Modify: `packages/authz-http-admin/src/controllers/AuthzAdminController.ts`:
  - the imports at lines 1-12;
  - the class at line 88;
  - `guarded`, `single` and `list` at lines 393-418;
  - the 18 call sites at lines 104-389.
- Test (modify): `packages/authz-http-admin/test/config.test.ts` (whole file) and `packages/authz-http-admin/test/routes.test.ts:5,15,688-713`

**Interfaces:**
- Consumes:
  - Task 5.3: `AUTHZ_HTTP_CONFIGURATION_SCHEMA.properties.admin.domain`, default `'root'`.
  - Task 5.1.
- Produces: `domainAdmin(domain: string)`. `adminDomain()` is deleted.

- [ ] **Step 1: Schema additions**

Done in Task 5.3 (`admin.domain`). Nothing more.

- [ ] **Step 2: Failing tests**

`packages/authz-http-admin/test/config.test.ts` (whole file: the existing tests, then a new `describe`):

```ts
import 'mocha';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';
import { AUTHZ_HTTP_CONFIGURATION_SCHEMA } from '@spinajs/authz-http';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import config from '../src/config/authz-http-admin.js';
import { AuthzAdminController } from '../src/index.js';

describe('shipped configuration', () => {
  const dirs = config.system.dirs.controllers.map((d) => d.replace(/\\/g, '/'));

  it('serves the controllers dir and no longer the 2.x legacy one', () => {
    expect(dirs).to.have.length(1);
    expect(dirs[0]).to.match(/\/authz-http-admin\/lib\/(mjs|cjs)\/controllers$/);
    expect(dirs.filter((d) => d.includes('legacy'))).to.deep.equal([]);
  });

  // http loads every file of a controllers dir; a barrel there would hand it the controller twice.
  it('keeps only controller files in the controllers dir', () => {
    expect(readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controllers'))).to.deep.equal(['AuthzAdminController.ts']);
  });

  it('runs the admin routes on the root domain by default', () => {
    expect(config.authz.http.admin.domain).to.equal('root');
  });

  it('ships no 2.x rbac.* keys', () => {
    expect(config).to.not.have.property('rbac');
  });
});

describe('authz.http.admin.domain through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(admin: unknown) {
    const booted = await bootConfiguration({ authz: { http: { admin } } }, [AUTHZ_HTTP_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const domainOf = (child: IContainer) => (bindConfiguration(new AuthzAdminController(), child) as unknown as { AdminDomain: string }).AdminDomain;

  it('the admin routes read it from the Configuration of the controller container', async () => {
    expect(domainOf(await boot({ domain: 'tenant' }))).to.equal('tenant');
  });

  it('is root when the app names none', async () => {
    expect(domainOf(await boot(undefined))).to.equal('root');
  });

  it('refuses an empty domain name at boot', async () => {
    expect(await violationPaths(boot({ domain: '' }))).to.include('authz.http.admin.domain');
  });
});
```

Edits to `packages/authz-http-admin/test/routes.test.ts`:
1. Line 15 becomes `import { domainAdmin } from '../src/routes/index.js';`.
2. Remove `AuthzConfigError` from the line 5 import. It has no other use.
3. Replace the whole `describe('domain', …)` block (lines 688-713) with:

```ts
  describe('domain', () => {
    it('runs the routes on the domain authz.http.admin.domain names, read on each call', async () => {
      const cfg = testHost.config();
      const before = cfg.get<unknown>(['authz', 'http', 'admin', 'domain']);
      try {
        const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
        expect(await domainAdmin(DOMAIN)).to.equal((await domains.service(DOMAIN)).admin());
        expect(await domainAdmin('root')).to.equal(((await DI.resolve(AuthzService)) as AuthzService).admin());

        cfg.set(['authz', 'http', 'admin', 'domain'], 'no-such-domain');
        const failed = await commands(root, { commands: [grant('carol')] });
        expect(failed.status).to.equal(500);
        expect(failed.headers['cache-control'], 'a 500 of POST /authz/commands').to.equal('no-store');
        const failedLink = await call('POST', '/authz/links', root, { scope: P1, role: 'viewer' });
        expect(failedLink.status).to.equal(500);
        expect(failedLink.headers['cache-control'], 'a 500 of POST /authz/links').to.equal('no-store');
      } finally {
        cfg.set(['authz', 'http', 'admin', 'domain'], before);
      }
      expect((await commands(root, { commands: [grant('carol')] })).status).to.equal(200);
    });
  });
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-http-admin && npx ts-mocha -p tsconfig.json test/config.test.ts`

Expected: the new `describe` fails.
- The two read tests get `expected undefined to equal 'tenant'` and `expected undefined to equal 'root'`: the property does not exist yet.
- The boot test passes, because the schema comes from Task 5.3.

`test/routes.test.ts` fails to compile with `TS2554: Expected 0 arguments, but got 1` at `domainAdmin(DOMAIN)`.

- [ ] **Step 4: Implement**

`packages/authz-http-admin/src/routes/domain.ts` (whole file):

```ts
import { DI } from '@spinajs/di';
import { AuthzDomains, AuthzService } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';

/** The AuthzAdmin of `domain`, the `authz.http.admin.domain` the admin routes read. */
export async function domainAdmin(domain: string): Promise<AuthzAdmin> {
  if (domain === 'root') return ((await DI.resolve(AuthzService)) as AuthzService).admin();
  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return (await domains.service(domain)).admin();
}
```

`packages/authz-http-admin/src/controllers/AuthzAdminController.ts`:

1. After line 2, add `import { Config } from '@spinajs/configuration';`.
2. Delete the module-level `guarded`, `single` and `list` functions (lines 393-418). Keep `results`.
3. In `AuthzAdminController`, add the property and the three methods:

```ts
  @Config('authz.http.admin.domain')
  protected AdminDomain: string;

  /** Runs a route on the domain's AuthzAdmin; an AuthzAdminFailure becomes its status with `{ error }`, anything else propagates. */
  protected async guarded(fn: (admin: AuthzAdmin) => Promise<Response>): Promise<Response> {
    const admin = await domainAdmin(this.AdminDomain);
    try {
      return await fn(admin);
    } catch (e) {
      if (e instanceof AuthzAdminFailure) return refused(e);
      throw e;
    }
  }

  /** One batch built from the route, with the options of the query string. */
  protected single(req: Request, build: () => AuthzCommand[]) {
    return this.guarded(async (admin) => {
      const opts = readWriteOptions(query(req));
      return results(await admin.execute(actorOf(req), build(), opts));
    });
  }

  protected list(req: Request, build: () => AuthzAdminQuery) {
    return this.guarded(async (admin) => respond(200, await admin.list(actorOf(req), build())));
  }
```

4. In the route methods:
   - every `return single(req,` becomes `return this.single(req,` (12 sites);
   - every `return list(req,` becomes `return this.list(req,` (5 sites);
   - the one `return guarded(` at line 104 becomes `return this.guarded(`.

`authz.http.admin.domain`'s `''` / non-string check disappears with `adminDomain()`. The schema refuses those values at boot.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-http-admin
npx ts-mocha -p tsconfig.json test/config.test.ts test/routes.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
```

- Expected: all passing.
- authz-http-admin has no dependants.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-http-admin/src packages/authz-http-admin/test/config.test.ts packages/authz-http-admin/test/routes.test.ts
git commit -m "refactor(authz-http-admin): authz.http.admin.domain through @Config and the schema, adminDomain removed"
```

---

### Task 5.6: `DefaultAdminGuard` and users-http `DefaultAccountGuard` read `authz.admin.guard` through `@Config`

**Files:**
- Modify: `packages/authz-rbac/src/admin/guard.ts:1-43,113-134`
- Modify: `packages/users-http/src/services/AccountGuard.ts:1-9,43-66,164-167`
- Test (new): `packages/authz-rbac/test/admin/guard-config.test.ts`
- Test (new): `packages/users-http/test/v3/account-guard-config.test.ts`
- Test (modify): `packages/authz-rbac/test/admin/guard.test.ts:148-171`
- Test (modify): `packages/users-http/test/v3/account-guard.test.ts:10,158-164`

**Interfaces:**
- Consumes:
  - the Phase 4 `authz.admin.guard` block: switches default to `true`, plus the `if/then` on `privilegedPermission`;
  - Task 5.1.
- Produces:
  - `AdminGuardConfig`, now documented as the validated shape;
  - `DefaultAdminGuard.Guard`;
  - `DefaultAccountGuard.Guard`.
- Removes `readGuardConfig`, which authz-rbac exported.

- [ ] **Step 1: Schema additions**

None. The block comes from Phase 4 (inventory: "from Phase 4").

- [ ] **Step 2: Failing tests**

`packages/authz-rbac/test/admin/guard-config.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { DefaultAdminGuard } from '../../src/index.js';
import type { AdminGuardConfig } from '../../src/index.js';

const expect = chai.expect;

describe('DefaultAdminGuard reads authz.admin.guard through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(guard: unknown): Promise<IContainer> {
    const booted = await bootConfiguration({ authz: { admin: { guard } } }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const guardOf = async (guard: unknown) => (bindConfiguration(new DefaultAdminGuard(), await boot(guard)) as unknown as { Guard: AdminGuardConfig }).Guard;

  it('from the Configuration of its container, with every absent switch on', async () => {
    expect(await guardOf({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update', preventEscalation: false })).to.deep.include({
      privilegedPermission: 'users:update',
      preventEscalation: false,
      protectSystemRole: true,
      preventSelfLockout: true,
      preventLastPrivilegedRemoval: true,
    });
  });

  it('needs no privilegedPermission while both checks that read it are off', async () => {
    expect((await guardOf({ preventSelfLockout: false, preventLastPrivilegedRemoval: false })).privilegedPermission).to.equal(undefined);
  });

  it('refuses at boot what readGuardConfig refused at the first command', async () => {
    expect(await violationPaths(boot({ privilegedPermission: 'users:update', preventEscalation: 'no' }))).to.include('authz.admin.guard.preventEscalation');
    expect(await violationPaths(boot({ service: 'DefaultAdminGuard' }))).to.include('authz.admin.guard.privilegedPermission');
    expect(await violationPaths(boot({ privilegedPermission: 'users' }))).to.include('authz.admin.guard.privilegedPermission');
  });
});
```

`packages/users-http/test/v3/account-guard-config.test.ts`:
- users-http has no authz-testing dependency, so the file boots its own child.

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import type { AdminGuardConfig } from '@spinajs/authz-rbac';
import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { DefaultAccountGuard } from '../../src/index.js';

/** `authz.admin.guard` as the Configuration of a fresh child, checked by the authz schema; no file source. */
async function boot(guard: unknown): Promise<IContainer> {
  const json = JSON.stringify({ authz: { admin: { guard } } });
  const child = DI.RootContainer.child();
  child.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  child
    .register(
      class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }
        protected onLoad(): unknown {
          return JSON.parse(json) as unknown;
        }
      },
    )
    .as(Configuration);
  try {
    await child.resolve(Configuration);
    return child;
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

describe('users-http v3: DefaultAccountGuard reads authz.admin.guard through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('from the Configuration of its container, with every absent switch on', async () => {
    const child = await boot({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update', preventSelfLockout: false });
    children.push(child);
    const guard = new DefaultAccountGuard();
    (guard as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;

    expect((guard as unknown as { Guard: AdminGuardConfig }).Guard).to.deep.include({ privilegedPermission: 'users:update', preventSelfLockout: false, preventLastPrivilegedRemoval: true });
  });

  it('a check that is on without privilegedPermission fails the boot, not the first lifecycle call', async () => {
    let error: unknown;
    try {
      children.push(await boot({ service: 'DefaultAdminGuard', preventLastPrivilegedRemoval: true }));
    } catch (e) {
      error = e;
    }

    expect(error).to.be.instanceOf(InvalidConfiguration);
    expect((error as InvalidConfiguration).violations.map((v) => v.path)).to.include('authz.admin.guard.privilegedPermission');
  });
});
```

Edits to `packages/authz-rbac/test/admin/guard.test.ts`. Replace the two tests:
- `'a missing or malformed privilegedPermission rejects the call; …'`
- `'a switch that is not a boolean rejects the call; an absent switch is on'`

(lines 148-171) with:

```ts
    it('with both checks that read it off, privilegedPermission is not needed', async () => {
      const { privilegedPermission: _, ...noPrivileged } = GUARD;
      await world({ guard: { ...noPrivileged, preventSelfLockout: false, preventLastPrivilegedRemoval: false } });
      await passes(p('ops'), [revoke('a-root'), revoke('a-root2')]);
    });

    // The malformed values and the absent switches are the schema's: guard-config.test.ts.
    it('each switch refuses what it guards', async () => {
      await refused(p('bob'), [grant('maintainer')], 'escalation');
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
      await refused(p('ops'), [revoke('a-root'), revoke('a-root2')], 'last_holder');
      await world({ rows: [...BASE, ...admins('root'), row('s1', user('dave'), 'sys', P1)] });
      await refused(p('ops'), [revoke('s1')], 'protected_role');
    });
```

Edits to `packages/users-http/test/v3/account-guard.test.ts`:
1. Delete the test `'fails closed when a check is on but no privilegedPermission is configured'` (lines 158-164). The schema refuses that configuration at boot (`account-guard-config.test.ts`).
2. Line 10 becomes `import { AuthzService, SYSTEM } from '@spinajs/authz';`.

- [ ] **Step 3: RED**

```bash
cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/guard-config.test.ts
cd ../users-http && npx ts-mocha -p tsconfig.json test/v3/account-guard-config.test.ts
```

Expected:
- In each file, the "from the Configuration of its container" test fails with `expected undefined to deep include …`: the guards have no `Guard` property yet.
- The boot tests pass already, through Phase 4's schema.

- [ ] **Step 4: Implement**

`packages/authz-rbac/src/admin/guard.ts`:
1. Line 1: remove `isPermission` from the import.
2. Line 3 becomes `import { Config } from '@spinajs/configuration';`.
3. Replace lines 13-43, which hold `AdminGuardConfig`, `KEY`, `SWITCHES` and `readGuardConfig`, with:

```ts
/** `authz.admin.guard` as AUTHZ_CONFIGURATION_SCHEMA leaves it: every switch set (default on). */
export interface AdminGuardConfig {
  /** Set while preventSelfLockout or preventLastPrivilegedRemoval is on: the schema requires it then. */
  readonly privilegedPermission?: Permission;
  readonly protectSystemRole: boolean;
  readonly preventEscalation: boolean;
  readonly preventSelfLockout: boolean;
  readonly preventLastPrivilegedRemoval: boolean;
}
```

4. In `DefaultAdminGuard`, add the property after `private warnedNoAccountStatus = false;`, and change `check` as follows. The rest of `check` stays.

```ts
  @Config('authz.admin.guard')
  protected Guard: AdminGuardConfig;

  async check(actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const kind: unknown = isPlainObject(c) ? c.kind : undefined;
    // Unknown kinds reach no handler (not_found); the handler owns validation.
    if (typeof kind !== 'string' || !Object.hasOwn(GUARDED, kind) || !GUARDED[kind as Kind]) return;
    const cfg = this.Guard;
    const roles = await roleIndex(ctx);
```

- Deleted from `check`:
  - `const container = adminContainer(ctx);`
  - `const where = …;`
  - the `Configuration` resolve;
  - the `readGuardConfig` call.
- `DefaultAdminGuard` is a root `@Singleton`, so it reads the root Configuration. Before, it resolved the domain container's Configuration. Domains register no Configuration of their own, so both are the same object.

`packages/users-http/src/services/AccountGuard.ts`:
1. Lines 3-4 become:

```ts
import { AssignmentStore } from '@spinajs/authz-rbac';
import type { AdminGuardConfig } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
```

2. In `DefaultAccountGuard`, add:

```ts
  @Config('authz.admin.guard')
  protected Guard: AdminGuardConfig;
```

3. Replace `const cfg = await guardConfig();` with `const cfg = this.Guard;`. It appears twice, in `assertCanDisable` and in `assertCanDemote`.
4. Delete the module function `guardConfig()` (lines 164-167).

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/admin/guard-config.test.ts test/admin/guard.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http
npx ts-mocha -p tsconfig.json test/v3/account-guard-config.test.ts test/v3/account-guard.test.ts
npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing. Every guard config in these suites lists the full guard, from `config/admin.ts` or the test's `GUARD`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/admin/guard.ts packages/authz-rbac/test/admin/guard-config.test.ts packages/authz-rbac/test/admin/guard.test.ts packages/users-http/src/services/AccountGuard.ts packages/users-http/test/v3/account-guard-config.test.ts packages/users-http/test/v3/account-guard.test.ts
git commit -m "refactor(authz-rbac, users-http): authz.admin.guard through @Config and the schema, readGuardConfig removed"
```

---

### Task 5.7: `DbAuthzAdminBackend` reads `authz.admin.connection` through `@Config`; `storeConnection` keeps its two-key fallback

**Files:**
- Modify: `packages/authz-rbac/src/admin/db/backend.ts:1-24,129-135,236-252`
- `packages/authz-rbac/src/stores/context.ts:61-79` (`storeConnection`): no change (D2, D8)
- Test (new): `packages/authz-rbac/test/admin/db/backend-config.test.ts`
- Test (modify): `packages/authz-rbac/test/admin/db/backend.test.ts:89`
- Test (modify): `packages/authz-rbac/test/integration/stores.db.test.ts:326,330`

**Interfaces:**
- Consumes:
  - Task 5.2: `authz.admin.connection` defaults to `'default'`;
  - Task 5.1.
- Produces: `DbAuthzAdminBackend.Connection`. Its options' `container` also chooses the Configuration it reads.

- [ ] **Step 1: Schema additions**

None.
- `authz.admin.connection` comes from Task 5.2.
- `authz.rbac.connection` keeps `connection: name` in `AUTHZ_RBAC_CONFIGURATION_SCHEMA`, with no default (D8).

- [ ] **Step 2: Failing tests**

`packages/authz-rbac/test/admin/db/backend-config.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DbAuthzAdminBackend } from '../../../src/index.js';

const expect = chai.expect;

describe('DbAuthzAdminBackend reads authz.admin.connection through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const connectionOf = (backend: DbAuthzAdminBackend) => (backend as unknown as { Connection: string }).Connection;

  it('from the Configuration of the container its options name', async () => {
    expect(connectionOf(new DbAuthzAdminBackend({ container: await boot({ admin: { connection: 'authz' } }) }))).to.equal('authz');
  });

  it('the default connection when the app names none', async () => {
    expect(connectionOf(new DbAuthzAdminBackend({ container: await boot({}) }))).to.equal('default');
  });

  it('refuses an empty authz.rbac.connection at boot; it has no default, so storeConnection can fall back to authz.admin.connection', async () => {
    expect(await violationPaths(boot({ rbac: { connection: '' } }))).to.include('authz.rbac.connection');
    const configuration = (await boot({ admin: { connection: 'authz' } })).get(Configuration);
    expect(configuration?.get('authz.rbac.connection')).to.equal(undefined);
  });
});
```

Edit `packages/authz-rbac/test/admin/db/backend.test.ts:89`:
- `config().set(['authz', 'admin', 'connection'], undefined);` becomes `config().set(['authz', 'admin', 'connection'], 'default');`.
- The in-memory test configuration applies no schema default.

Edit `packages/authz-rbac/test/integration/stores.db.test.ts`:
1. Line 326, `configuration.set('authz.admin.connection', undefined);`, becomes `configuration.set('authz.admin.connection', 'default');`. A runtime `set` skips the schema.
2. The title at line 330 becomes `'with neither key named by the app, both use the default connection (the schema default of authz.admin.connection)'`.

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/db/backend-config.test.ts`

Expected:
- The first two tests fail with `expected undefined to equal 'authz'` and `expected undefined to equal 'default'`. The property does not exist yet.
- The third test passes.

- [ ] **Step 4: Implement**

`packages/authz-rbac/src/admin/db/backend.ts`:
1. Line 3 becomes `import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';`.
2. `DbAuthzAdminBackendOptions`:

```ts
export interface DbAuthzAdminBackendOptions {
  /** The ORM connection; default: config authz.admin.connection. */
  readonly connection?: string;
  /** Where Configuration and Orm are resolved; default the DI root. */
  readonly container?: IContainer;
}
```

3. The class head:

```ts
@Singleton()
@Injectable(AuthzAdminBackend)
export class DbAuthzAdminBackend extends AuthzAdminBackend {
  @Config(CONNECTION_KEY)
  protected Connection: string;

  constructor(private readonly opts: DbAuthzAdminBackendOptions = {}) {
    super();
    // Built with `new` for a container, it reads that container's Configuration, as when DI builds it there.
    if (opts.container) (this as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = opts.container;
  }
```

4. `connection()`:

```ts
  private async connection(): Promise<OrmDriver> {
    const container = this.opts.container ?? DI.RootContainer;
    const name = this.opts.connection ?? this.Connection;
    const orm = (await container.resolve(Orm)) as Orm;
    const driver = orm.Connections.get(name);
    if (!driver) throw new AuthzConfigError(`DbAuthzAdminBackend: ${CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
  }
```

Deleted: the `Configuration` resolve, the string check, and `?? 'default'`.

`storeConnection` (`stores/context.ts`) stays as it is.
- It is a free function over each store's container.
- It falls back from `authz.rbac.connection` to `authz.admin.connection`, then to `'default'`, and that order is the rule (D8).
- The schema validates both keys.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/admin/db/backend-config.test.ts test/admin/db/backend.test.ts test/integration/stores.db.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http && npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing. Both the rbac test database and the canvas database register the core schema (Task 5.2), and so do the users and users-http configs.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/admin/db/backend.ts packages/authz-rbac/test/admin/db/backend-config.test.ts packages/authz-rbac/test/admin/db/backend.test.ts packages/authz-rbac/test/integration/stores.db.test.ts
git commit -m "refactor(authz-rbac): DbAuthzAdminBackend reads authz.admin.connection through @Config, the default from the schema"
```

---

### Task 5.8: `ConfigRoleStore` reads `authz.rbac.roles` and `ladders` through `@Config`; its shape helpers go

**Files:**
- Modify: `packages/authz-rbac/src/stores/config-role-store.ts:1-178` (whole file)
- Test (modify): `packages/authz-rbac/test/stores/config-role-store.test.ts:1,16,282-329,339-358`
- Test (modify): `packages/authz-rbac/test/cli/check-config.test.ts:68-75`
- Harness checks that read the store's injected `configuration`:
  - `packages/authz-rbac/test/integration/db-harness.ts:5,134`
  - `packages/authz-testing/test/canvas-c6/harness.ts:8,145-146`

**Interfaces:**
- Consumes:
  - `AUTHZ_RBAC_CONFIGURATION_SCHEMA.roles` and `.ladders`, as they exist today. The inventory adds nothing.
  - Task 5.1.
- Produces:
  - `ConfigRoleStore.Roles` and `ConfigRoleStore.Ladders`, read through `@Config`.
  - The constructor takes an optional `Pick<Configuration, 'get'>`, a test seam (global decision 4). It replaces `@Inject(Configuration)`.

- [ ] **Step 1: Schema additions**

None (inventory). The schema already covers every check the helpers made: closed objects, enums, string lists.

- [ ] **Step 2: Failing tests**

Edits to `packages/authz-rbac/test/stores/config-role-store.test.ts`:

1. Line 1 becomes `import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';`, because `AuthzConfigError` loses its last use.
2. Add `import { bootConfiguration } from '@spinajs/authz-testing';`.
3. Delete `describe('malformed shapes', …)` (lines 282-329). The schema checks those shapes at boot, and `describe('authz-rbac stores: authz.rbac schema')` already asserts each one.
4. In `'resolves with the Configuration of its container'`:
   - The store reads through `@Config`, which needs the container's Configuration resolved.
   - After `.as(Configuration);`, add `await child.resolve(Configuration);`.
5. Add this test to `describe('authz-rbac stores: ConfigRoleStore in DI')`:

```ts
  it('reads authz.rbac.roles and ladders through @Config of its container', async () => {
    const { child } = await bootConfiguration({ authz: { rbac: { roles: { a: { grants: ['x:read'] } }, ladders: { l: { roles: ['a'] } } } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    try {
      child.register(ConfigRoleStore).as(RoleStore);
      const store = (await child.resolve(RoleStore)) as ConfigRoleStore;

      expect((store as unknown as { Roles: unknown }).Roles).to.deep.equal({ a: { grants: ['x:read'] } });
      expect(await store.load()).to.deep.equal({
        roles: [{ name: 'a', extends: [], grants: [{ permission: 'x:read' }], assignable: true, source: 'config' }],
        ladders: [{ name: 'l', roles: ['a'] }],
      });
    } finally {
      await child.dispose();
    }
  });
```

Edit `packages/authz-rbac/test/cli/check-config.test.ts:68-75`.
- The command still prints a refused role configuration. Shapes are now refused at boot, so the error comes from a store.
- Replace the test with:

```ts
  it('prints the config error and exits 1 when a role store refuses its configuration', async () => {
    const { cmd } = command(GOOD);
    cmd.Roles = new (class extends RoleStore {
      readonly name = 'RefusingRoleStore';
      async load(): Promise<never> {
        throw new AuthzConfigError('authz.rbac.roles.viewer: role ghost is not defined');
      }
      async version(): Promise<string> {
        return 'v';
      }
    })();
    await cmd.execute({});
    expect(io.err).to.have.length(1);
    expect(io.err[0]).to.contain('authz.rbac.roles.viewer');
    expect(io.exitCode()).to.equal(1);
    expect(io.out).to.deep.equal([]);
  });
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/stores/config-role-store.test.ts`

Expected: the new test fails with `expected undefined to deep equal { a: … }`. `ConfigRoleStore` has no `Roles` yet.

- [ ] **Step 4: Implement**

`packages/authz-rbac/src/stores/config-role-store.ts` (whole file):

```ts
import { createHash } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

import { RoleStore } from '../contracts.js';
import type { GrantDef, LadderDef, RoleDef } from '../contracts.js';

/** One `authz.rbac.roles.<name>` entry as configured; AUTHZ_RBAC_CONFIGURATION_SCHEMA checks it. */
interface RoleEntry extends Partial<Omit<RoleDef, 'name' | 'grants' | 'source'>> {
  readonly grants?: readonly (string | GrantDef)[];
  readonly revoke?: readonly string[];
}

type LadderEntry = Omit<LadderDef, 'name'>;
type Raw = Record<string, unknown>;

// A plain copy: the result is frozen and must not alias the configuration.
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as unknown as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T;
  return value;
}

/**
 * `revoke` removes, after the configuration merged every fragment, each grant of this role whose permission equals a
 * listed string exactly (no globs); a string grant counts, as it reads `{ permission }`. Inherited grants are untouched.
 */
function role(name: string, entry: RoleEntry): RoleDef {
  const { revoke = [], grants = [], extends: parents = [], assignable = true, ...rest } = copy(entry);
  const revoked = new Set(revoke);
  return {
    name,
    ...rest,
    extends: parents,
    grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)).filter((g) => !revoked.has(g.permission)),
    assignable,
    source: 'config',
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Sorted keys, so reordering an object does not change the hash; list order does.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Raw;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Roles and ladders from `authz.rbac.roles` and `authz.rbac.ladders`. AUTHZ_RBAC_CONFIGURATION_SCHEMA checks their
 * shape at boot; the `extends` graph, unknown roles, ladders and permissions are the model's compile step.
 *
 * Registered by class name only: AuthzAdmin reads every `RoleStore` a domain registers, so one
 * registered as `RoleStore` at import would join every domain.
 */
@Injectable()
export class ConfigRoleStore extends RoleStore {
  readonly name = 'ConfigRoleStore';

  @Config('authz.rbac.roles')
  protected Roles: Readonly<Record<string, RoleEntry>> | undefined;

  @Config('authz.rbac.ladders')
  protected Ladders: Readonly<Record<string, LadderEntry>> | undefined;

  /** `configuration`: read in place of the Configuration of the store's container (tests, a host that builds the model itself). */
  constructor(protected readonly configuration?: Pick<Configuration, 'get'>) {
    super();
  }

  async load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }> {
    const { roles, ladders } = this.raw();
    return deepFreeze({
      roles: Object.entries(roles ?? {}).map(([n, r]) => role(n, r)),
      ladders: Object.entries(ladders ?? {}).map(([n, l]): LadderDef => ({ name: n, ...copy(l) })),
    });
  }

  async version(): Promise<string> {
    const { roles, ladders } = this.raw();
    return createHash('sha256')
      .update(canonical({ roles: roles ?? {}, ladders: ladders ?? {} }))
      .digest('hex');
  }

  private raw(): { roles?: Readonly<Record<string, RoleEntry>>; ladders?: Readonly<Record<string, LadderEntry>> } {
    if (this.configuration) {
      return {
        roles: this.configuration.get<Readonly<Record<string, RoleEntry>> | undefined>(['authz', 'rbac', 'roles']),
        ladders: this.configuration.get<Readonly<Record<string, LadderEntry>> | undefined>(['authz', 'rbac', 'ladders']),
      };
    }
    return { roles: this.Roles, ladders: this.Ladders };
  }
}
```

Deleted, about 110 LOC that duplicated the schema check for check:
- `ROOT`, `ROLE_KEYS`, `GRANT_KEYS`, `IMPLIES_KEYS`, `LADDER_KEYS`, `IMPLIES_AT`, `BYPASS`;
- `isPlain`, `key`, `fail`, `object`, `text`, `list`, `texts`, `flag`, `optional`;
- the checking bodies of `grant`, `implied`, `role` and `ladder`;
- `@Inject(Configuration)`.

What remains is compiling (D4): the string grant, `revoke`, the `extends` and `assignable` defaults of an entry, and freezing.

Harness checks.
- They read the store's `configuration` field, which only the seam sets now.
- They are replaced by a check of the Configuration the store actually reads.

1. `packages/authz-rbac/test/integration/db-harness.ts`:
   1. Line 5 becomes `import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';`.
   2. Add `import type { IContainer } from '@spinajs/di';`.
   3. Line 134 becomes:

```ts
      if ((roles as unknown as Record<string, IContainer>)[CONFIGURATION_CONTAINER_KEY].get(Configuration) !== configuration) throw new Error("dbHarness: the RoleStore does not read this case's Configuration");
```

2. `packages/authz-testing/test/canvas-c6/harness.ts`:
   1. Line 8 becomes `import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';`.
   2. Line 9 becomes `import type { Class, IContainer } from '@spinajs/di';`.
   3. Lines 145-146 become:

```ts
  const roles = (await c.resolve(RoleStore)) as unknown as Record<string, IContainer>;
  if (roles[CONFIGURATION_CONTAINER_KEY].get(Configuration) !== configuration) throw new Error("canvasHarness: the RoleStore does not read this case's Configuration");
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/stores/config-role-store.test.ts test/cli/check-config.test.ts test/stores/register.test.ts test/links/links.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http && npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing. users and telemetry build `new ConfigRoleStore(configuration)`, the kept seam.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/stores/config-role-store.ts packages/authz-rbac/test/stores/config-role-store.test.ts packages/authz-rbac/test/cli/check-config.test.ts packages/authz-rbac/test/integration/db-harness.ts packages/authz-testing/test/canvas-c6/harness.ts
git commit -m "refactor(authz-rbac): ConfigRoleStore reads roles and ladders through @Config, the shape checks left to the schema"
```

---

### Task 5.9: `RULE_SCHEMA` moves into `AUTHZ_RBAC_CONFIGURATION_SCHEMA.rules.items`; `ConfigRuleStore` reads through `@Config`

**Files:**
- Modify: `packages/authz-rbac/src/stores/schema.ts:1-75` (rule definitions added; the `rules` line changes)
- Modify: `packages/authz-rbac/src/stores/config-rule-store.ts:1-174` (whole file)
- Test (modify): `packages/authz-rbac/test/rules/store.test.ts:1-50,70-75`, plus a new `describe`

**Interfaces:**
- Consumes: Task 5.1.
- Produces:
  - `AUTHZ_RBAC_CONFIGURATION_SCHEMA.properties.rules.items`.
  - `readRuleDefs(rules, source?)`, which no longer validates.
  - `ConfigRuleStore.Rules`.
  - The `ConfigRuleStore(source?: Pick<Configuration, 'get'> | readonly RuleDef[])` seam. `canvas-c6` passes a Configuration; tests pass lists.
- Removes the exported `RULE_SCHEMA` and the package's own Ajv instance.

- [ ] **Step 1: Schema additions**

In `packages/authz-rbac/src/stores/schema.ts`, after `const role = closed({...});` (line 50), add:

```ts
const ruleNames = { type: 'array', items: name, minItems: 1 };
const ref = closed({ type: name, id: { type: 'string' } }, ['type']);
const principalRef = closed({ type: name, id: { type: 'string' } }, ['type', 'id']);
const valueRef = closed({ ref: name }, ['ref']);
// Conditions are checked by the condition parser, which knows the registered functions.
const condition = { type: 'object' };
const RULE_KINDS = ['restrict', 'cap', 'threshold'];

// A rule without a scope applies at $global (ConfigRuleStore fills it in). A bare type is on the path of a list only,
// never of a check, so lists and checks would disagree.
const ruleScope = { ...ref, if: { not: { required: ['id'] } }, then: { properties: { type: { const: '$global' } } } };

const ruleSubjects = closed({
  principalTypes: ruleNames,
  actorTypes: ruleNames,
  refs: { type: 'array', items: principalRef, minItems: 1 },
  rank: { ...closed({ ladder: name, at: name, lt: name, eq: name, gte: name }, ['ladder', 'at']), oneOf: [{ required: ['lt'] }, { required: ['eq'] }, { required: ['gte'] }] },
  when: condition,
});

const ruleCommon = {
  id: name,
  kind: { type: 'string', enum: RULE_KINDS },
  scope: ruleScope,
  resourceTypes: ruleNames,
  subjects: ruleSubjects,
  when: condition,
  expiresAt: { type: ['string', 'null'], format: 'date-time' },
  source: { type: 'string' },
};

// One key set per kind (design §5.8).
const ruleOf = (kind: string, properties: Record<string, unknown>, extra: Record<string, unknown>) => ({
  if: { properties: { kind: { const: kind } } },
  then: { ...closed({ ...ruleCommon, ...properties }), ...extra },
});

/** A config RuleDef (design §5.8), the former RULE_SCHEMA of ConfigRuleStore. */
const rule = {
  type: 'object',
  properties: { id: name, kind: { type: 'string', enum: RULE_KINDS }, scope: ruleScope },
  required: ['id', 'kind'],
  allOf: [
    ruleOf('restrict', { allow: { type: 'array', items: { anyOf: [principalRef, closed({ set: closed({ role: name, scope: ref }, ['role', 'scope']) }, ['set'])] } } }, { required: ['allow'] }),
    ruleOf(
      'cap',
      {
        ladder: name,
        maxRole: { anyOf: [{ type: ['string', 'null'], minLength: 1 }, valueRef] },
        stripTags: { type: 'boolean' },
        assignments: closed({ scopeTypes: ruleNames, subjectTypes: ruleNames }),
      },
      { anyOf: [{ required: ['ladder', 'maxRole'] }, { required: ['stripTags'], properties: { stripTags: { const: true } } }], dependencies: { maxRole: ['ladder'] } },
    ),
    ruleOf(
      'threshold',
      {
        permissions: ruleNames,
        resource: condition,
        minRole: { anyOf: [name, valueRef] },
        ladder: name,
        at: name,
        reason: { type: 'object', properties: { code: name, priority: { type: 'number' }, sortKey: { type: 'string' }, model: false }, required: ['code'] },
      },
      { required: ['permissions', 'minRole'], dependencies: { at: ['ladder'] } },
    ),
  ],
};
```

In `AUTHZ_RBAC_CONFIGURATION_SCHEMA.properties`, replace the two lines

```ts
    // L1b owns the rule schema
    rules: { type: 'array', items: { type: 'object' } },
```

with

```ts
    rules: { type: 'array', items: rule, uniqueItemProperties: ['id'] },
```

How this differs from the old `RULE_SCHEMA`:
- `additionalProperties: false` became `propertyNames` (D6).
- `scope` is no longer required: ConfigRuleStore fills in GLOBAL. The bare-type rule moved here from code.
- Duplicate ids are refused by `uniqueItemProperties`, also moved from code.
- `expiresAt` is a nullable `date-time`.
- `maxRole` has no null branch inside an `anyOf` (D6).

- [ ] **Step 2: Failing tests**

Edits to `packages/authz-rbac/test/rules/store.test.ts`:
1. Change the imports:

```ts
import { GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, ConfigRuleStore, readRuleDefs } from '../../src/index.js';
import { CANVAS_RULES } from './canvas-rules.js';
```

2. Delete the `refused` helper (lines 17-26) and the test `'refuses malformed rules, naming the rule and the path'` (lines 36-50).
3. At the end of the file, add:

```ts
describe('authz-rbac authz.rbac.rules schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(rules: unknown): Promise<Configuration> {
    const booted = await bootConfiguration({ authz: { rbac: { rules } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (rules: unknown) => violationPaths(boot(rules));

  it('takes valid rules of each kind; ConfigRuleStore gives a rule without a scope GLOBAL', async () => {
    const configuration = await boot([
      { id: 'r1', kind: 'restrict', scope: O1, allow: [{ type: 'user', id: 'u1' }, { set: { role: 'org.member', scope: O1 } }] },
      cap({ subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } }, assignments: { subjectTypes: ['user'] }, expiresAt: '2027-01-01T00:00:00.000Z' }),
      { id: 's1', kind: 'cap', scope: GLOBAL, stripTags: true, when: { attr: 'scope.org.policies.addons', eq: false } },
      { id: 'c2', kind: 'cap', ladder: 'project', maxRole: null },
      { id: 'c3', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } },
      { id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:*'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', reason: { code: 'branch_protected', pattern: 'release/*', priority: 700, sortKey: 'release/*' } },
      { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: { ref: 'principal.attributes.min' } },
    ]);
    const rules = new ConfigRuleStore(configuration).all();

    expect(rules.map((r) => r.id)).to.deep.equal(['r1', 'c1', 's1', 'c2', 'c3', 't1', 't2']);
    expect(rules.find((r) => r.id === 'c2')!.scope).to.deep.equal(GLOBAL);
    expect(rules.find((r) => r.id === 'c1')!.expiresAt).to.deep.equal(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('refuses a malformed rule at boot, naming the full path', async () => {
    expect(await refused({})).to.include('authz.rbac.rules');
    expect(await refused([cap({ colour: 'red' })])).to.include('authz.rbac.rules.0.colour');
    expect(await refused([cap({ kind: 'grant' })])).to.include('authz.rbac.rules.0.kind');
    expect(await refused([{ id: 'c1', kind: 'cap', scope: GLOBAL }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([{ id: 'c1', kind: 'cap', scope: GLOBAL, maxRole: 'viewer' }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([cap({ maxRole: '' })])).to.include('authz.rbac.rules.0.maxRole');
    expect(await refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'] }])).to.include('authz.rbac.rules.0.minRole');
    expect(await refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', at: 'org' }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', reason: { code: 'x', model: 'abac' } }])).to.include('authz.rbac.rules.0.reason.model');
    expect(await refused([cap({ subjects: { rank: { ladder: 'org', at: 'org', lt: 'a', gte: 'b' } } })])).to.include('authz.rbac.rules.0.subjects.rank');
    expect(await refused([{ id: 'r1', kind: 'restrict', scope: O1, allow: [], ladder: 'project' }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([cap({ expiresAt: 'soon' })])).to.include('authz.rbac.rules.0.expiresAt');
    expect(await refused([cap(), cap()])).to.include('authz.rbac.rules');
    expect(await refused([cap({ scope: { type: 'file' } })])).to.include('authz.rbac.rules.0.scope.type');
  });
});
```

`'reads authz.rbac.rules from the configuration'` (lines 70-75) stays. It uses the `Configuration` seam.

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/rules/store.test.ts`

Expected:
- `'refuses a malformed rule at boot'` fails with `expected the configuration boot to fail with InvalidConfiguration, but it booted`. Today `rules.items` is `{ type: 'object' }`.
- The `'takes valid rules'` test passes.

- [ ] **Step 4: Implement**

1. Apply Step 1.
2. Write `packages/authz-rbac/src/stores/config-rule-store.ts` (whole file):

```ts
import { createHash } from 'node:crypto';
import { AuthzConfigError, GLOBAL, resourceKey } from '@spinajs/authz';
import type { ResourceRef, RuleDef } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

import { RuleStore } from '../contracts.js';

/**
 * Rules as frozen RuleDefs: a rule without a scope applies at GLOBAL (design §5.8; §8.5 writes none), `source` is
 * filled and an ISO `expiresAt` becomes a Date. AUTHZ_RBAC_CONFIGURATION_SCHEMA checks the shape of
 * `authz.rbac.rules`; the RBAC model checks ladders, roles, permissions and conditions when it compiles them.
 * @throws AuthzConfigError for an `expiresAt` that is not a date (a list given to ConfigRuleStore skips the schema)
 */
export function readRuleDefs(rules: readonly unknown[], source = 'config'): readonly RuleDef[] {
  return Object.freeze(
    rules.map((given, i) => {
      const r = given as RuleDef;
      return deepFreeze({ ...r, scope: r.scope ?? GLOBAL, source: r.source ?? source, ...expiry(r.expiresAt, `authz.rbac.rules[${i}] (id '${r.id}')`) });
    }),
  );
}

function expiry(value: unknown, at: string): { expiresAt?: Date | null } {
  if (value === undefined || value === null) return value === null ? { expiresAt: null } : {};
  const ms = typeof value === 'string' ? Date.parse(value) : Object.prototype.toString.call(value) === '[object Date]' ? Date.prototype.getTime.call(value) : NaN;
  if (Number.isNaN(ms)) throw new AuthzConfigError(`${at}: expiresAt must be a date or an ISO date string`);
  return { expiresAt: new Date(ms) };
}

/**
 * Rules from config (design §8.2 `authz.rbac.rules`) through @Config, or from a list or a Configuration given to the
 * constructor (tests, a host that builds the model itself). Registered by its class name; `registerRbacStores` binds
 * it to `RuleStore` when `authz.rbac.stores.rules` names it (the default).
 */
@Injectable()
export class ConfigRuleStore extends RuleStore {
  readonly name = 'ConfigRuleStore';

  @Config('authz.rbac.rules')
  protected Rules: readonly unknown[] | undefined;

  private loaded?: readonly RuleDef[];
  private hash?: string;

  constructor(private readonly source?: Pick<Configuration, 'get'> | readonly RuleDef[]) {
    super();
  }

  /** Every rule, expired ones included; the model reads them without IO. */
  all(): readonly RuleDef[] {
    this.loaded ??= readRuleDefs(this.configured() ?? []);
    return this.loaded;
  }

  /** The rules live at `at` whose scope is one of `path`. */
  rulesOn(path: readonly ResourceRef[], at: Date): readonly RuleDef[] {
    const keys = new Set(path.map(resourceKey));
    return this.all().filter((r) => keys.has(resourceKey(r.scope)) && (r.expiresAt == null || r.expiresAt.getTime() > at.getTime()));
  }

  async forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]> {
    return this.rulesOn(path, at);
  }

  async version(): Promise<string> {
    this.hash ??= createHash('sha256').update(JSON.stringify(this.all())).digest('hex');
    return this.hash;
  }

  private configured(): readonly unknown[] | undefined {
    if (Array.isArray(this.source)) return this.source as readonly RuleDef[];
    const configuration = this.source as Pick<Configuration, 'get'> | undefined;
    return configuration ? configuration.get<readonly unknown[] | undefined>(['authz', 'rbac', 'rules']) : this.Rules;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Date)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
```

Deleted:
- `import Ajv`;
- the JSON fragments `name`, `names`, `ref`, `principalRef`, `valueRef`, `condition`, `subjects` and `COMMON`;
- `RULE_SCHEMA`, `AjvError`, `Validate`, `compiled` and `validator()`;
- `readRuleDefs`' validation, and its checks for the bare-type scope, duplicate ids and `resource.*` reads.

The model's compile step reports those `resource.*` reads (`ruleConditionFault`). None of the deleted checks needs DI.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/rules/store.test.ts test/stores/config-role-store.test.ts test/links/links.test.ts test/rules/rules.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http && npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing. `test/stores/config-role-store.test.ts` "rejects bad shapes" still passes for `rules: [1]` and `rules: {}`, and the §8.5 sample rule is valid under the new items.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/stores/schema.ts packages/authz-rbac/src/stores/config-rule-store.ts packages/authz-rbac/test/rules/store.test.ts
git commit -m "refactor(authz-rbac): the rule schema joins authz.rbac.rules, ConfigRuleStore reads through @Config without its own Ajv"
```

---

### Task 5.10: `DbLinkStore` reads `authz.rbac.links.secret` through `@Config`

**Files:**
- Modify: `packages/authz-rbac/src/stores/db-link-store.ts:1-25,69-80,245-256`
- Test (new): `packages/authz-rbac/test/stores/link-secret-config.test.ts`
- Test (modify): `packages/authz-rbac/test/stores/db-link-store.test.ts:651-669`

**Interfaces:**
- Consumes:
  - `AUTHZ_RBAC_CONFIGURATION_SCHEMA.links.secret` (`minLength: 32`, exists);
  - Task 5.1.
- Produces: `DbLinkStore.Secret`. A store built with `new DbLinkStore(container)` reads that container's Configuration (D1).

- [ ] **Step 1: Schema additions**

None (inventory). `links: { secret: { type: 'string', minLength: 32 } }` exists.

There is no `required`. Only a domain that uses `DbLinkStore` needs the secret, so the presence check stays in code (D5).

- [ ] **Step 2: Failing tests**

`packages/authz-rbac/test/stores/link-secret-config.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DbLinkStore } from '../../src/index.js';

const expect = chai.expect;

describe('DbLinkStore reads authz.rbac.links.secret through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  const boot = (secret: string) => bootConfiguration({ authz: { rbac: { links: { secret } } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);

  it('from the Configuration of the container it is built for', async () => {
    const { child } = await boot('s'.repeat(32));
    children.push(child);

    expect((new DbLinkStore(child) as unknown as { Secret: string }).Secret).to.equal('s'.repeat(32));
  });

  it('a secret shorter than 32 characters fails the boot', async () => {
    expect(await violationPaths(boot('x'.repeat(31)))).to.include('authz.rbac.links.secret');
  });
});
```

Edit `packages/authz-rbac/test/stores/db-link-store.test.ts`:
- `'is required, as a string of at least 32 characters, at first use'` becomes a check of presence only. The length belongs to the schema and is covered by the new file.
- Retitle the test `'is required at first use'`.
- Change its loop header to `for (const secret of [undefined, null]) {`.
- Delete the line `if (typeof secret === 'string' && secret.length > 0) expect((err as Error).message).to.not.include(secret);`.

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/stores/link-secret-config.test.ts`

Expected:
- The first test fails with `expected undefined to equal 'ssss…'`. There is no `Secret` property yet.
- The boot test passes.

- [ ] **Step 4: Implement**

`packages/authz-rbac/src/stores/db-link-store.ts`:
1. Line 3 becomes `import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';`.
2. In the class, after `protected readonly maxListLimit…`, add the property, and replace the constructor:

```ts
  // Optional here: only a domain that uses DbLinkStore needs a secret, which only DI knows; the schema checks its length.
  @Config(LINK_SECRET_KEY)
  protected Secret: string | undefined;

  constructor(protected readonly container: IContainer) {
    super();
    // Built with `new`, the store reads the Configuration of the container it is given, as when DI builds it there.
    (this as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = container;
  }
```

3. `secret()`:

```ts
  /** Read on every use, so the store can be resolved before the secret is configured. */
  protected async secret(): Promise<string> {
    const secret = this.Secret;
    if (secret === undefined || secret === null) throw new AuthzConfigError(`${LINK_SECRET_KEY} must be set to hash share link tokens: a string of at least ${MIN_SECRET_LENGTH} characters`);
    return secret;
  }
```

- Deleted: the `Configuration` resolve and the type and length checks.
- `MIN_SECRET_LENGTH` stays, for the message.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/stores/link-secret-config.test.ts test/stores/db-link-store.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http && npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/stores/db-link-store.ts packages/authz-rbac/test/stores/link-secret-config.test.ts packages/authz-rbac/test/stores/db-link-store.test.ts
git commit -m "refactor(authz-rbac): DbLinkStore reads the link secret through @Config, its length checked by the schema"
```

---

### Task 5.11: rbac model `ctx.config` readers keep their reads; their checks move to the schema; `groupPrincipal` takes `null` and partial objects

**Files:**
- Modify: `packages/authz-rbac/src/stores/schema.ts`:
  - the imports;
  - the comment at lines 52-54;
  - the properties `groupPrincipal`, `anonymousRoles`, `serviceRoles` and `cache`.
- Modify: `packages/authz-rbac/src/model/cache.ts:8-9` (gets `DEFAULT_ROLES_CHECK_SECONDS`)
- Modify: `packages/authz-rbac/src/model/model.ts:5,44,440-457,494-503`
- Modify: `packages/authz-rbac/src/model/sets/resolver.ts:1,90-104`
- Test (new): `packages/authz-rbac/test/model/config.test.ts`
- Test (modify):
  - `test/model/model.test.ts:206-207`
  - `test/model/preload.test.ts:170-180`
  - `test/model/reload.test.ts:286-290`
  - `test/sets/sets.test.ts:78-86`
  - `test/stores/config-role-store.test.ts:16,385-397,423`

**Interfaces:**
- Consumes: Task 5.1.
- Produces:
  - `AUTHZ_RBAC_CONFIGURATION_SCHEMA` defaults for `cache.*`, `groupPrincipal`, `anonymousRoles` and `serviceRoles`.
  - `DEFAULT_ROLES_CHECK_SECONDS` now lives in `model/cache.ts`. It is still exported from the package root.

**Decision (D2):**
- These readers stay `ctx.config` reads, and their `dflt` arguments stay.
- A model instance is shared across domains and is not built by DI.
- `ModelInitContext.config` reads `authz.rbac.*` of the Configuration that the domain's container resolves. That Configuration may be unvalidated, for example a fake context or `TestConfiguration`.
- The checks needing the role graph stay in code (`refuseConfigRole`).

- [ ] **Step 1: Schema additions**

In `packages/authz-rbac/src/stores/schema.ts`, add:

```ts
import { DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS } from '../model/cache.js';
import { DEFAULT_GROUP_PRINCIPAL } from '../model/sets/resolver.js';
```

Replace the comment above `AUTHZ_RBAC_CONFIGURATION_SCHEMA` (lines 52-54) with:

```ts
// Validates the `authz.rbac` subtree: the configuration reads `$configurationModule` with lodash get, so a dotted path
// works and this schema runs next to the core one (`authz`), which leaves `rbac` open. The root stays open for keys of
// other lanes. Store names and migration columns have no default here: they live in code (RBAC_STORE_DEFAULTS, the migrations).
```

Replace the four properties with:

```ts
    // null turns the group member set off; a key left out keeps its default.
    groupPrincipal: {
      type: ['object', 'null'],
      default: {},
      properties: { role: { ...name, default: DEFAULT_GROUP_PRINCIPAL.role }, scopeType: { ...name, default: DEFAULT_GROUP_PRINCIPAL.scopeType } },
      propertyNames: { enum: ['role', 'scopeType'] },
    },
    anonymousRoles: { ...stringList, default: [] },
    serviceRoles: { type: 'object', additionalProperties: stringList, default: {} },
    cache: {
      type: 'object',
      default: {},
      properties: {
        assignmentsTtlSeconds: { type: 'number', minimum: 0, default: DEFAULT_ASSIGNMENTS_TTL_SECONDS },
        maxSubjects: { type: 'integer', minimum: 0, default: DEFAULT_MAX_CACHED_SUBJECTS },
        rolesCheckSeconds: { type: 'number', minimum: 0, default: DEFAULT_ROLES_CHECK_SECONDS },
      },
    },
```

`defaultRoles` and the remaining properties stay as they are.

- [ ] **Step 2: Failing tests**

`packages/authz-rbac/test/model/config.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { bootConfiguration, fakeModelInitContext, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_GROUP_PRINCIPAL, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS, groupPrincipalConfig } from '../../src/index.js';

const expect = chai.expect;

describe('authz-rbac model configuration through the schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(rbac: unknown): Promise<Configuration> {
    const booted = await bootConfiguration({ authz: { rbac } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (rbac: unknown) => violationPaths(boot(rbac));

  it('fills the defaults the model reads, from the same constants', async () => {
    const configuration = await boot(undefined);

    expect(configuration.get('authz.rbac.cache')).to.deep.equal({ assignmentsTtlSeconds: DEFAULT_ASSIGNMENTS_TTL_SECONDS, maxSubjects: DEFAULT_MAX_CACHED_SUBJECTS, rolesCheckSeconds: DEFAULT_ROLES_CHECK_SECONDS });
    expect(configuration.get('authz.rbac.groupPrincipal')).to.deep.equal(DEFAULT_GROUP_PRINCIPAL);
    expect(configuration.get('authz.rbac.anonymousRoles')).to.deep.equal([]);
    expect(configuration.get('authz.rbac.serviceRoles')).to.deep.equal({});
  });

  it('takes a partial or a null groupPrincipal, as groupPrincipalConfig reads it', async () => {
    expect((await boot({ groupPrincipal: { role: 'team' } })).get('authz.rbac.groupPrincipal')).to.deep.equal({ role: 'team', scopeType: 'group' });
    const off = (await boot({ groupPrincipal: null })).get('authz.rbac.groupPrincipal');
    expect(off).to.equal(null);
    expect(groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: { groupPrincipal: off } }))).to.equal(null);
  });

  it('refuses at boot what the model refused at init', async () => {
    expect(await refused({ anonymousRoles: 'guest' })).to.include('authz.rbac.anonymousRoles');
    expect(await refused({ serviceRoles: { 'service:x': 'telemetry' } })).to.include('authz.rbac.serviceRoles.service:x');
    expect(await refused({ cache: { assignmentsTtlSeconds: -1 } })).to.include('authz.rbac.cache.assignmentsTtlSeconds');
    expect(await refused({ cache: { maxSubjects: 1.5 } })).to.include('authz.rbac.cache.maxSubjects');
    expect(await refused({ cache: { rolesCheckSeconds: -1 } })).to.include('authz.rbac.cache.rolesCheckSeconds');
    expect(await refused({ groupPrincipal: { role: '' } })).to.include('authz.rbac.groupPrincipal.role');
    expect(await refused({ groupPrincipal: 'group.member' })).to.include('authz.rbac.groupPrincipal');
    expect(await refused({ groupPrincipal: { name: 'x' } })).to.include('authz.rbac.groupPrincipal.name');
  });
});
```

Edits to existing tests:

1. `test/model/model.test.ts`: delete the last two entries of the refused-at-init table (lines 206-207):
   - `['anonymousRoles that are not an array of names', …]`
   - `['serviceRoles that are not a map of role lists', …]`

   These are now schema cases. The unknown and non-assignable role cases stay: they need the role graph.
2. `test/model/preload.test.ts`: delete `'refuses a malformed cache config at init'` (lines 170-180).
3. `test/model/reload.test.ts`: delete `'refuses a malformed rolesCheckSeconds at init'` (lines 286-290).
4. `test/sets/sets.test.ts`: replace `'groupPrincipalConfig reads the config and refuses a malformed value'` (lines 78-86) with:

```ts
    it('groupPrincipalConfig reads the config: absent or partial keeps the defaults, null turns it off', () => {
      const config = (groupPrincipal: unknown) => groupPrincipalConfig(fakeModelInitContext({ model: 'rbac', config: groupPrincipal === undefined ? {} : { groupPrincipal } }));
      expect(config(undefined)).to.deep.equal(DEFAULT_GROUP_PRINCIPAL);
      expect(config(null)).to.equal(null);
      expect(config({ role: 'team', scopeType: 'team' })).to.deep.equal({ role: 'team', scopeType: 'team' });
      expect(config({ role: 'team' })).to.deep.equal({ role: 'team', scopeType: 'group' });
    });
```

   Then remove `AuthzConfigError` from that file's imports if nothing else uses it.
5. `test/stores/config-role-store.test.ts`:
   1. Line 16 becomes `import { DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_GROUP_PRINCIPAL, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS, RoleStore } from '../../src/index.js';`.
   2. Replace `'has no default keywords'` (lines 385-388) with:

```ts
  it('defaults what the RBAC model reads to the code defaults', () => {
    const cfg: any = {};
    expect(validate(cfg).ok).to.equal(true);
    expect(cfg).to.deep.equal({
      groupPrincipal: DEFAULT_GROUP_PRINCIPAL,
      anonymousRoles: [],
      serviceRoles: {},
      cache: { assignmentsTtlSeconds: DEFAULT_ASSIGNMENTS_TTL_SECONDS, maxSubjects: DEFAULT_MAX_CACHED_SUBJECTS, rolesCheckSeconds: DEFAULT_ROLES_CHECK_SECONDS },
    });
  });
```

   3. In `'accepts the §8.2 and §8.5 samples unchanged'` (lines 390-397):
      - Retitle it `'accepts the §8.2 and §8.5 samples and adds only the model defaults'`.
      - Replace `expect(sample).to.deep.equal(copy);` with the line below. Validation now fills these four keys.

```ts
      const defaulted = ['groupPrincipal', 'anonymousRoles', 'serviceRoles', 'cache'];
      expect(_.omit(sample, defaulted)).to.deep.equal(_.omit(copy, defaulted));
```

   4. In `'rejects bad shapes'`:
      - Replace `fails({ groupPrincipal: { role: 'g' } }, '/groupPrincipal', 'required');` (line 423) with `fails({ groupPrincipal: { role: '' } }, '/groupPrincipal/role', 'minLength');`.
      - After the `assignmentsTtlSeconds` line, add:

```ts
    fails({ cache: { maxSubjects: 1.5 } }, '/cache/maxSubjects', 'type');
    fails({ cache: { rolesCheckSeconds: -1 } }, '/cache/rolesCheckSeconds', 'minimum');
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/config.test.ts`

Expected:
- `'fills the defaults'` fails: `authz.rbac.cache` is `undefined`.
- The `groupPrincipal` test fails: the boot is refused at `authz.rbac.groupPrincipal.scopeType`, because both fields are required today.
- `'refuses at boot'` fails at `maxSubjects` and `rolesCheckSeconds`: the boot passes.

- [ ] **Step 4: Implement**

1. Apply Step 1.
2. `packages/authz-rbac/src/model/cache.ts`: after line 9, add `export const DEFAULT_ROLES_CHECK_SECONDS = 60;`.
3. `packages/authz-rbac/src/model/model.ts`:
   1. Line 5 becomes `import { AssignmentCache, DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS } from './cache.js';`.
   2. Delete line 44, `export const DEFAULT_ROLES_CHECK_SECONDS = 60;`.
   3. Replace `anonymousRoles`, `serviceRoles` and `cacheConfig`, and delete `isNameList`:

```ts
// The configuration schema checks the shapes; whether a role exists and is assignable needs the role graph.
function anonymousRoles(ctx: ModelInitContext, graph: RoleGraph): readonly string[] {
  const value = ctx.config<readonly string[]>('anonymousRoles', []);
  for (const role of value) refuseConfigRole(graph, role, 'authz.rbac.anonymousRoles');
  return Object.freeze([...value]);
}

function serviceRoles(ctx: ModelInitContext, graph: RoleGraph): ReadonlyMap<string, readonly string[]> {
  const value = ctx.config<Readonly<Record<string, readonly string[]>>>('serviceRoles', {});
  const out = new Map<string, readonly string[]>();
  for (const [key, roles] of Object.entries(value)) {
    for (const role of roles) refuseConfigRole(graph, role, `authz.rbac.serviceRoles['${key}']`);
    out.set(key, Object.freeze([...roles]));
  }
  return out;
}
```

```ts
function cacheConfig(ctx: ModelInitContext): { ttlMs: number; maxEntries: number; rolesCheckMs: number } {
  const ttl = ctx.config<number>('cache.assignmentsTtlSeconds', DEFAULT_ASSIGNMENTS_TTL_SECONDS);
  const max = ctx.config<number>('cache.maxSubjects', DEFAULT_MAX_CACHED_SUBJECTS);
  const check = ctx.config<number>('cache.rolesCheckSeconds', DEFAULT_ROLES_CHECK_SECONDS);
  return { ttlMs: ttl * 1000, maxEntries: max, rolesCheckMs: check * 1000 };
}
```

4. `packages/authz-rbac/src/model/sets/resolver.ts`:
   1. Line 1 becomes `import { principalKey } from '@spinajs/authz';`.
   2. Replace lines 90-104 with:

```ts
/** `authz.rbac.groupPrincipal`: `null` turns the mapping off; an absent value, or a key left out of it, keeps its default. */
export function groupPrincipalConfig(ctx: ModelInitContext): GroupPrincipalConfig | null {
  const value = ctx.config<Partial<GroupPrincipalConfig> | null | undefined>('groupPrincipal', undefined);
  return value === null ? null : Object.freeze({ ...DEFAULT_GROUP_PRINCIPAL, ...value });
}
```

The `dflt` arguments of `ctx.config` stay (D2).

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/model/config.test.ts test/model/model.test.ts test/model/preload.test.ts test/model/reload.test.ts test/sets/sets.test.ts test/stores/config-role-store.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http && npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/stores/schema.ts packages/authz-rbac/src/model/cache.ts packages/authz-rbac/src/model/model.ts packages/authz-rbac/src/model/sets/resolver.ts packages/authz-rbac/test/model/config.test.ts packages/authz-rbac/test/model/model.test.ts packages/authz-rbac/test/model/preload.test.ts packages/authz-rbac/test/model/reload.test.ts packages/authz-rbac/test/sets/sets.test.ts packages/authz-rbac/test/stores/config-role-store.test.ts
git commit -m "refactor(authz-rbac): the model's config checks move to the schema with its defaults; groupPrincipal takes null and partial objects"
```

---

### Task 5.12: new `authz.token` schema; `loadTokenRoleRules` keeps its read and drops its checks

**Files:**
- Create: `packages/authz-rbac/src/token/schema.ts`
- Modify: `packages/authz-rbac/src/token/index.ts` (one export line)
- Modify: `packages/authz-rbac/src/token/rules.ts:1-14,73-102`
- Modify: `packages/authz-rbac/src/stores/bootstrap.ts:1-11`
- Test (modify):
  - `packages/authz-rbac/test/token/rules.test.ts:1-10,202-238`, plus a new `describe` inside `describe('loadTokenRoleRules')`
  - `packages/authz-rbac/test/stores/config-role-store.test.ts`: the `'the bootstrapper registers the schema…'` test, lines 466-477

**Interfaces:**
- Consumes: Task 5.1.
- Produces:
  - `AUTHZ_TOKEN_CONFIGURATION_SCHEMA` (`$configurationModule: 'authz.token'`), registered by `RbacConfigBootstrapper`.
  - `loadTokenRoleRules(configuration, container)`, same signature, no value checks.

**Where `@Config` cannot apply:**
- `tokenRoleExtension` is a model-extension factory, not a DI class. Its `init` loads the rules from the domain container's Configuration, or from root outside a host.
- The read stays (D2). The `TokenRolePolicy` lookup by class name stays (D5, a DI lookup).

- [ ] **Step 1: Schema additions**

`packages/authz-rbac/src/token/schema.ts`:

```ts
import { DEFAULT_TOKEN_ROLE_POLICY } from './rules.js';

// A role name, or a 'prefix.*' pattern: a full glob in a security list is refused on purpose.
const ROLE_OR_PREFIX = '^[^*]+(\\.\\*)?$';

/** `authz.token.*` (design §8.2, §18.3(g)): the roles a token principal loses, and the TokenRolePolicy that narrows the rest. */
export const AUTHZ_TOKEN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-token.configuration.schema.json',
  $configurationModule: 'authz.token',
  description: 'Token role rules (authz.token.*)',
  type: 'object',
  properties: {
    excludedRoles: { type: 'array', default: [], items: { type: 'string', minLength: 1, pattern: ROLE_OR_PREFIX } },
    rolePolicy: { type: 'object', default: {}, properties: { service: { type: 'string', minLength: 1, default: DEFAULT_TOKEN_ROLE_POLICY } } },
  },
};
```

- [ ] **Step 2: Failing tests**

`packages/authz-rbac/test/token/rules.test.ts`:
1. Change the imports:

```ts
import { AuthzConfigError, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, Principal } from '@spinajs/authz';
import { Container, DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { bootConfiguration, fakeModelInitContext, userPrincipal, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_TOKEN_CONFIGURATION_SCHEMA, DEFAULT_TOKEN_ROLE_POLICY, MemoryAssignmentStore, MemoryRoleStore, OwnRolesTokenRolePolicy, RbacModel, RbacService, TokenRolePolicy, TokenRoleRules, isTokenPrincipal, loadTokenRoleRules, roleExcluded } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';
```

2. Delete the `badExcluded` and `badService` tables and their loops (lines 202-238).
3. At the end of `describe('loadTokenRoleRules', …)`, add:

```ts
    describe('the authz.token schema', () => {
      const children: IContainer[] = [];

      afterEach(async () => {
        for (const c of children.splice(0)) await c.dispose();
      });

      async function boot(token: unknown): Promise<Configuration> {
        const booted = await bootConfiguration({ authz: { token } }, [AUTHZ_TOKEN_CONFIGURATION_SCHEMA]);
        children.push(booted.child);
        return booted.configuration;
      }

      const refused = (token: unknown) => violationPaths(boot(token));

      it('defaults to no excluded roles and OwnRolesTokenRolePolicy', async () => {
        expect((await boot(undefined)).get('authz.token')).to.deep.equal({ excludedRoles: [], rolePolicy: { service: DEFAULT_TOKEN_ROLE_POLICY } });
      });

      it('feeds loadTokenRoleRules', async () => {
        const rules = await loadTokenRoleRules(await boot({ excludedRoles: ['route.*'] }), container);
        expect(rules.excludedRoles).to.deep.equal(['route.*']);
        expect(rules.policy).to.be.instanceOf(OwnRolesTokenRolePolicy);
      });

      const badExcluded: [string, unknown][] = [
        ['not an array', 'route.*'],
        ['an empty name', ['']],
        ['a full glob', ['*']],
        ['a star inside a name', ['route*']],
        ['a star before the end', ['route.*.admin']],
        ['two stars', ['route.*.*']],
        ['an empty prefix', ['.*']],
      ];
      for (const [title, value] of badExcluded) {
        it(`refuses authz.token.excludedRoles with ${title} at boot`, async () => {
          expect((await refused({ excludedRoles: value })).some((p) => p.startsWith('authz.token.excludedRoles'))).to.equal(true);
        });
      }

      it('refuses a rolePolicy that is not an object, or an empty service name, at boot', async () => {
        expect(await refused({ rolePolicy: 'OwnRolesTokenRolePolicy' })).to.include('authz.token.rolePolicy');
        expect(await refused({ rolePolicy: { service: '' } })).to.include('authz.token.rolePolicy.service');
      });
    });
```

`packages/authz-rbac/test/stores/config-role-store.test.ts`, the test `'the bootstrapper registers the schema as a __configurationSchema__ value'`:
- Add `AUTHZ_TOKEN_CONFIGURATION_SCHEMA` to the `'../../src/index.js'` import.
- Rename the test to `'the bootstrapper registers the rbac and token schemas as __configurationSchema__ values'`.
- Its body becomes:

```ts
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new RbacConfigBootstrapper().bootstrap();
    try {
      expect(DI.RootContainer.Cache.get(KEY)).to.include.members([AUTHZ_RBAC_CONFIGURATION_SCHEMA, AUTHZ_TOKEN_CONFIGURATION_SCHEMA]);
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      for (const schema of [AUTHZ_RBAC_CONFIGURATION_SCHEMA, AUTHZ_TOKEN_CONFIGURATION_SCHEMA]) list.splice(list.indexOf(schema), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/token/rules.test.ts`

Expected: the file fails to compile with `TS2305: Module '"../../src/index.js"' has no exported member 'AUTHZ_TOKEN_CONFIGURATION_SCHEMA'`.

- [ ] **Step 4: Implement**

1. Create `token/schema.ts` (Step 1).
2. In `packages/authz-rbac/src/token/index.ts`, add `export * from './schema.js';`.
3. `packages/authz-rbac/src/token/rules.ts`:
   1. Delete the constants `EXCLUDED_KEY` and `POLICY_KEY`. `SERVICE_KEY` stays, for the messages of `resolvePolicy`.
   2. Replace lines 73-102 (`loadTokenRoleRules`, `excludedRoles`, `serviceName`) with:

```ts
/**
 * Reads `authz.token.excludedRoles` and `authz.token.rolePolicy.service` (AUTHZ_TOKEN_CONFIGURATION_SCHEMA checks
 * them) and resolves the policy from `container`: the TokenRolePolicy registration whose class name is the service name.
 * @throws (rejects) AuthzConfigError for a service no registered TokenRolePolicy class carries
 */
export async function loadTokenRoleRules(configuration: Pick<Configuration, 'get'>, container: IContainer): Promise<TokenRoleRules> {
  const excluded = configuration.get<readonly string[]>(['authz', 'token', 'excludedRoles'], []);
  const service = configuration.get<string>(['authz', 'token', 'rolePolicy', 'service'], DEFAULT_TOKEN_ROLE_POLICY);
  return new TokenRoleRules(excluded, await resolvePolicy(container, service));
}
```

4. `packages/authz-rbac/src/stores/bootstrap.ts` (whole file):

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';
import { AUTHZ_TOKEN_CONFIGURATION_SCHEMA } from '../token/schema.js';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from './schema.js';

@Injectable(Bootstrapper)
export class RbacConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_RBAC_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_TOKEN_CONFIGURATION_SCHEMA);
  }
}
```

`token/extension.ts` does not change. It is the reader that `@Config` cannot replace.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-rbac
npx ts-mocha -p tsconfig.json test/token/rules.test.ts test/token/extension.test.ts test/token/behaviour.test.ts test/stores/config-role-store.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../users-http && npm test
cd ../users && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../authz-convert && npm test
cd ../email && npm test
cd ../telemetry && npm test
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/token/schema.ts packages/authz-rbac/src/token/index.ts packages/authz-rbac/src/token/rules.ts packages/authz-rbac/src/stores/bootstrap.ts packages/authz-rbac/test/token/rules.test.ts packages/authz-rbac/test/stores/config-role-store.test.ts
git commit -m "feat(authz-rbac): an authz.token schema in place of the token rule checks"
```

---

### Task 5.13: authz-abac gets an `authz.abac` schema; `storesFromConfig` and `ConfigPolicyStore` drop their type checks

**Files:**
- Create: `packages/authz-abac/src/model/schema.ts`
- Modify:
  - `packages/authz-abac/src/model/index.ts` (one export line)
  - `packages/authz-abac/src/model/model.ts:1-11,496-516`
  - `packages/authz-abac/src/model/stores/config.ts:1-24`
  - `packages/authz-abac/package.json:54-64`: `@spinajs/configuration` moves from `devDependencies` to `dependencies`
- Test (new): `packages/authz-abac/test/model/config.test.ts`

**Interfaces:**
- Consumes: Task 5.1.
- Produces:
  - `AUTHZ_ABAC_CONFIGURATION_SCHEMA` (`$configurationModule: 'authz.abac'`);
  - `AbacConfigBootstrapper`;
  - `ABAC_STORE_NAMES`, `ABAC_DEFAULT_STORES`, `ABAC_DEFAULT_CONNECTION`;
  - `ConfigPolicyStore(policies: readonly unknown[] = [])`.

**Where `@Config` cannot apply:**
- `storesFromConfig` runs in the model's `init` through `ctx.config`.
- `AbacModel` is not a DI class and may run under another name.
- So the reads and their fallbacks stay (D2), and only the type checks go.
- The throw for an unknown store name stays (D5). It is reachable for a model named other than `abac`, whose section no schema covers.

- [ ] **Step 1: Schema additions**

`packages/authz-abac/src/model/schema.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

/** The policy stores `authz.<model>.stores` may name (design §8.3). */
export const ABAC_STORE_NAMES = Object.freeze(['ConfigPolicyStore', 'DbPolicyStore'] as const);
export const ABAC_DEFAULT_STORES: readonly string[] = Object.freeze(['ConfigPolicyStore']);
export const ABAC_DEFAULT_CONNECTION = 'default';

// Covers the model under its default name only: a model named otherwise reads an unchecked authz.<name>. The model
// checks each policy when it loads it, because it compiles their conditions.
export const AUTHZ_ABAC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-abac.configuration.schema.json',
  $configurationModule: 'authz.abac',
  description: 'ABAC configuration (authz.abac.*)',
  type: 'object',
  properties: {
    stores: { type: 'array', default: [...ABAC_DEFAULT_STORES], items: { type: 'string', enum: [...ABAC_STORE_NAMES] } },
    policies: { type: 'array', default: [], items: { type: 'object' } },
    connection: { type: 'string', minLength: 1, default: ABAC_DEFAULT_CONNECTION },
  },
};

@Injectable(Bootstrapper)
export class AbacConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ABAC_CONFIGURATION_SCHEMA);
  }
}
```

- [ ] **Step 2: Failing tests**

`packages/authz-abac/test/model/config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { bootConfiguration, fakeModelInitContext, violationPaths } from '@spinajs/authz-testing';
import type { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_ABAC_CONFIGURATION_SCHEMA, AbacConfigBootstrapper, storesFromConfig } from '../../src/index.js';

describe('authz.abac configuration schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(abac: unknown): Promise<Configuration> {
    const booted = await bootConfiguration({ authz: { abac } }, [AUTHZ_ABAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (abac: unknown) => violationPaths(boot(abac));

  it('fills the defaults storesFromConfig reads', async () => {
    expect((await boot(undefined)).get('authz.abac')).to.deep.equal({ stores: ['ConfigPolicyStore'], policies: [], connection: 'default' });
  });

  it('a validated authz.abac builds its stores', async () => {
    const configuration = await boot({ stores: ['ConfigPolicyStore', 'DbPolicyStore'], connection: 'abac' });
    const ctx = fakeModelInitContext({ config: configuration.get<Record<string, unknown>>('authz.abac') });

    expect(storesFromConfig('abac', ctx).map((s) => s.constructor.name)).to.deep.equal(['ConfigPolicyStore', 'DbPolicyStore']);
  });

  it('refuses at boot what storesFromConfig and ConfigPolicyStore refused at init', async () => {
    expect(await refused({ stores: 'ConfigPolicyStore' })).to.include('authz.abac.stores');
    expect(await refused({ stores: ['Nope'] })).to.include('authz.abac.stores.0');
    expect(await refused({ policies: {} })).to.include('authz.abac.policies');
    expect(await refused({ policies: ['x'] })).to.include('authz.abac.policies.0');
    expect(await refused({ connection: '' })).to.include('authz.abac.connection');
  });

  it('the bootstrapper registers the schema', () => {
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new AbacConfigBootstrapper().bootstrap();
    try {
      expect(DI.RootContainer.Cache.get(KEY)).to.include(AUTHZ_ABAC_CONFIGURATION_SCHEMA);
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      list.splice(list.indexOf(AUTHZ_ABAC_CONFIGURATION_SCHEMA), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
  });
});
```

The existing `test/model/review.test.ts` test `'builds the stores authz.<name>.stores names, and refuses unknown names'` stays as it is.

- [ ] **Step 3: RED**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/model/config.test.ts`

Expected: the file fails to compile with `TS2305: Module '"../../src/index.js"' has no exported member 'AUTHZ_ABAC_CONFIGURATION_SCHEMA'` (also `AbacConfigBootstrapper`).

- [ ] **Step 4: Implement**

1. Create `model/schema.ts` (Step 1). In `packages/authz-abac/src/model/index.ts`, add `export * from './schema.js';`.

2. `packages/authz-abac/package.json`:
   - add `"@spinajs/configuration": "2.0.549"` to `dependencies`;
   - remove it from `devDependencies`.

   The bootstrapper calls `registerConfigurationSchema` at run time. The workspace link already exists, so no install is needed.

3. `packages/authz-abac/src/model/model.ts`:
   1. After line 11, add `import { ABAC_DEFAULT_CONNECTION, ABAC_DEFAULT_STORES, ABAC_STORE_NAMES } from './schema.js';`.
   2. Replace lines 496-516 (`STORE_NAMES` and `storesFromConfig`) with:

```ts
/** The stores `authz.<model>.stores` names (design §8.3); DbPolicyStore resolves its connection on first use. */
export function storesFromConfig(model: string, ctx: Pick<ModelInitContext, 'config'>): PolicyStore[] {
  const names = ctx.config<readonly string[]>('stores', ABAC_DEFAULT_STORES);
  const policies = ctx.config<readonly unknown[]>('policies', []);
  return names.map((name) => {
    if (name === 'ConfigPolicyStore') return new ConfigPolicyStore(policies);
    if (name === 'DbPolicyStore') {
      const connection = ctx.config<string>('connection', ABAC_DEFAULT_CONNECTION);
      return new DbPolicyStore(async () => {
        const driver = (await DI.resolve(Orm)).Connections.get(connection);
        if (!driver) throw new AuthzConfigError(`authz.${model}.connection: no ORM connection named ${JSON.stringify(connection)}`);
        return driver;
      });
    }
    // AUTHZ_ABAC_CONFIGURATION_SCHEMA covers authz.abac only; a model under another name reads an unchecked section.
    throw new AuthzConfigError(`authz.${model}.stores names ${JSON.stringify(name)}, which is not a policy store (${ABAC_STORE_NAMES.join(', ')})`);
  });
}
```

   What changed:
   - `names === undefined` no longer gets its own branch: `ABAC_DEFAULT_STORES` is the same single `ConfigPolicyStore`.
   - The list type check is deleted.
   - The ORM connection lookup stays: it is a DI lookup.

4. `packages/authz-abac/src/model/stores/config.ts`:
   1. Delete `import { AuthzConfigError } from '@spinajs/authz';`.
   2. Change the constructor's head:

```ts
  constructor(policies: readonly unknown[] = []) {
    super();
    this.policies = Object.freeze([...(policies as Policy[])]);
```

   The `Array.isArray` check is deleted. The schema checks `authz.abac.policies`, and authz-fs passes the `policies` lists it parsed itself.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-abac
npx ts-mocha -p tsconfig.json test/model/config.test.ts test/model/review.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../authz-fs && npm test
cd ../authz-rbac && npm test
cd ../authz-testing && npm test
cd ../users && npm test
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-abac/src/model/schema.ts packages/authz-abac/src/model/index.ts packages/authz-abac/src/model/model.ts packages/authz-abac/src/model/stores/config.ts packages/authz-abac/package.json packages/authz-abac/test/model/config.test.ts
git commit -m "feat(authz-abac): an authz.abac schema in place of the store and policy type checks"
```

---

### Task 5.14: authz-fs gets `authz.fs` and `authz.fsMetadata` schemas; `parseFsAccessConfig` keeps only what a schema cannot do

**Files:**
- Create: `packages/authz-fs/src/access-config/schema.ts`
- Modify: `packages/authz-fs/src/access-config/index.ts:1-203` (whole file)
- Modify: `packages/authz-fs/src/metadata/connection.ts:1-16` (whole file)
- Test (modify): `packages/authz-fs/test/config.test.ts:1-10,54-74,80-117,134-142,177-180`, plus a new `describe`
- The 8 callers of `fsAccessConfig` / `fsAccessConfigs` do not change:
  - `contributor/index.ts:26`
  - `decorator/index.ts:22`
  - `domain/index.ts:118`
  - `guard/index.ts:104,347`
  - `http/upload.ts:46`
  - `inherit/index.ts:43`
  - `metadata/select.ts:18`
  - `resolvers/index.ts:16`

**Interfaces:**
- Consumes: Task 5.1.
- Produces:
  - `AUTHZ_FS_CONFIGURATION_SCHEMA` (`authz.fs`: one entry schema for every filesystem name);
  - `AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA` (`authz.fsMetadata`);
  - `AuthzFsConfigBootstrapper`;
  - `FS_METADATA_DEFAULT_CONNECTION`;
  - `parseFsAccessConfig(fsName, entry)`, which now only normalises.

**Where `@Config` cannot apply:**
- `fsAccessConfig(fsName, container)`, `fsAccessConfigs(container)` and `fsMetadataConnection(container)` are free functions. Every caller passes its own container.
- The reads stay (D2).
- The schema validates the entries; `parseFsAccessConfig` keeps two jobs:
  - D4: the `domain` default of an entry, a scope for a policy that has none, prototype-free copies, freezing;
  - D5: the policy scope must be the filesystem of its key.

- [ ] **Step 1: Schema additions**

`packages/authz-fs/src/access-config/schema.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { FS_METADATA_DEFAULT_CONNECTION } from '../metadata/connection.js';
import { FS_RESOURCE_TYPES } from '../refs/index.js';

const name = { type: 'string', minLength: 1 };
// The name part of isPermission's pattern; a permission is two of them around ':'.
const ACTION = '[A-Za-z][A-Za-z0-9_.-]*';
const permission = { type: 'string', pattern: `^${ACTION}:${ACTION}$` };

// propertyNames refuses an unknown key; additionalProperties: false would let removeAdditional drop a typo silently.
const closed = (properties: Record<string, unknown>, required?: string[]) => ({ type: 'object', properties, propertyNames: { enum: Object.keys(properties) }, ...(required ? { required } : {}) });

// The fs-abac model checks the rest of a policy when it loads it.
const policy = {
  type: 'object',
  properties: {
    permissions: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^fs:' } },
    resourceTypes: { type: 'array', items: { type: 'string', enum: [...FS_RESOURCE_TYPES] } },
  },
  required: ['permissions'],
};

const entry = {
  ...closed(
    {
      mode: { type: 'string', enum: ['off', 'audit', 'enforce'] },
      domain: name,
      metadata: name,
      stampOwner: { type: 'boolean' },
      resolver: name,
      // fs-inherit checks `<parent type>:<action>`, so the action alone must complete a permission name.
      inherit: { type: 'object', propertyNames: { pattern: `^fs:${ACTION}$` }, additionalProperties: { type: 'string', pattern: `^${ACTION}$` } },
      signedUrl: closed({ maxTtlSeconds: { type: 'number', exclusiveMinimum: 0 }, defaultTtlSeconds: { type: 'number', exclusiveMinimum: 0 } }),
      policies: { type: 'array', items: policy },
      operations: { type: 'object', propertyNames: { not: { enum: ['__proto__', 'constructor', 'prototype'] } }, additionalProperties: { anyOf: [permission, { type: 'array', minItems: 1, items: permission }] } },
      list: { type: 'string', enum: ['dir', 'each'] },
    },
    // A present entry says its mode: one with policies but no mode must not be silently off.
    ['mode'],
  ),
  // The owners live in the FileMetadataStore that `metadata` names.
  if: { properties: { stampOwner: { const: true } }, required: ['stampOwner'] },
  then: { required: ['metadata'] },
};

/** `authz.fs.<filesystem>` (design §13): one entry per filesystem name; a filesystem without one is off. */
export const AUTHZ_FS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-fs.configuration.schema.json',
  $configurationModule: 'authz.fs',
  description: 'Filesystem access configuration (authz.fs.<filesystem>)',
  type: 'object',
  additionalProperties: entry,
};

export const AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-fs-metadata.configuration.schema.json',
  // Not under authz.fs: that section is keyed by filesystem name.
  $configurationModule: 'authz.fsMetadata',
  description: 'File metadata store configuration (authz.fsMetadata.*)',
  type: 'object',
  properties: { connection: { ...name, default: FS_METADATA_DEFAULT_CONNECTION } },
};

@Injectable(Bootstrapper)
export class AuthzFsConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_FS_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA);
  }
}
```

Two decisions in this schema:
- `additionalProperties: entry` applies the inventory's "patternProperties per fs": it validates every filesystem name.
- The configuration's lodash merge already drops a JSON `__proto__` key, so `operations` refuses `constructor` and `prototype`.

- [ ] **Step 2: Failing tests**

Edits to `packages/authz-fs/test/config.test.ts`:
1. Imports, lines 1-10:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_FS_CONFIGURATION_SCHEMA, AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA, fsAccessConfig, parseFsAccessConfig } from '../src/index.js';
import { configuredChild } from './helpers.js';
```

2. In the `refused` table (lines 55-65), keep only the four scope rows:
   - `'a scope on a domain parent'`
   - `'a scope on another filesystem'`
   - `'a scope on a directory of another filesystem'`
   - `'a scope without an id'`

   Delete the four permission and resource-type rows. The schema covers them (item 3).
3. Delete:
   - the `bad` table and its loop (lines 80-117);
   - the `for (const key of ['__proto__', 'constructor', 'prototype'])` loop (lines 134-142);
   - the test `'refuses an authz.fs that is not an object'` (lines 177-180).
4. At the end of the file, add:

```ts
describe('authz-fs config: the authz.fs and authz.fsMetadata schemas', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<Configuration> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_FS_CONFIGURATION_SCHEMA, AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (entry: unknown) => violationPaths(boot({ fs: { uploads: entry } }));

  const ENTRY = {
    mode: 'enforce',
    domain: 'fs',
    metadata: 'OrmFileMetadataStore',
    stampOwner: true,
    resolver: 'TaskAttachmentPathResolver',
    inherit: { 'fs:read': 'read', 'fs:write': 'update', 'fs:delete': 'update' },
    signedUrl: { maxTtlSeconds: 900, defaultTtlSeconds: 300 },
    policies: [{ id: 'public', effect: 'permit', permissions: ['fs:read', 'fs:stat'], when: { attr: 'resource.id', glob: 'uploads:public/**' } }],
    operations: { thumbnail: 'fs:read', publish: ['fs:read', 'fs:share'] },
    list: 'each',
  };

  it('takes every documented key unchanged', async () => {
    expect((await boot({ fs: { uploads: ENTRY } })).get('authz.fs.uploads')).to.deep.equal(ENTRY);
  });

  it('an unset authz.fs has no entries; authz.fsMetadata.connection defaults to the default connection', async () => {
    const configuration = await boot({});
    expect(configuration.get('authz.fs')).to.deep.equal({});
    expect(configuration.get('authz.fsMetadata.connection')).to.equal('default');
  });

  it('refuses an authz.fs that is not an object', async () => {
    expect(await violationPaths(boot({ fs: ['uploads'] }))).to.include('authz.fs');
  });

  const BAD: [string, unknown, string][] = [
    ['an entry that is not an object', 'enforce', 'authz.fs.uploads'],
    ['an array entry', [], 'authz.fs.uploads'],
    ['a missing mode', { domain: 'fs' }, 'authz.fs.uploads.mode'],
    ['an unknown mode', { mode: 'strict' }, 'authz.fs.uploads.mode'],
    ['an unknown key', { mode: 'enforce', Mode: 'off' }, 'authz.fs.uploads.Mode'],
    ['an empty domain', { mode: 'enforce', domain: '' }, 'authz.fs.uploads.domain'],
    ['an object metadata', { mode: 'enforce', metadata: {} }, 'authz.fs.uploads.metadata'],
    ['a non-boolean stampOwner', { mode: 'enforce', stampOwner: 'yes' }, 'authz.fs.uploads.stampOwner'],
    ['stampOwner without a metadata store', { mode: 'enforce', stampOwner: true }, 'authz.fs.uploads.metadata'],
    ['an empty resolver', { mode: 'enforce', resolver: '' }, 'authz.fs.uploads.resolver'],
    ['an inherit list', { mode: 'enforce', inherit: ['fs:read'] }, 'authz.fs.uploads.inherit'],
    ['an inherit key that is no permission', { mode: 'enforce', inherit: { read: 'read' } }, 'authz.fs.uploads.inherit.read'],
    ['an inherit key that is no fs permission', { mode: 'enforce', inherit: { 'task:read': 'read' } }, 'authz.fs.uploads.inherit.task:read'],
    ['an inherit action that is no action name', { mode: 'enforce', inherit: { 'fs:read': 'task:read' } }, 'authz.fs.uploads.inherit.fs:read'],
    ['a signedUrl that is not an object', { mode: 'enforce', signedUrl: 900 }, 'authz.fs.uploads.signedUrl'],
    ['a zero maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['a zero defaultTtlSeconds', { mode: 'enforce', signedUrl: { defaultTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.defaultTtlSeconds'],
    ['an unknown signedUrl key', { mode: 'enforce', signedUrl: { ttl: 5 } }, 'authz.fs.uploads.signedUrl.ttl'],
    ['policies that are not a list', { mode: 'enforce', policies: {} }, 'authz.fs.uploads.policies'],
    ['a policy that is not an object', { mode: 'enforce', policies: ['x'] }, 'authz.fs.uploads.policies.0'],
    ['a policy with a non-fs permission', { mode: 'enforce', policies: [{ id: 'staff', permissions: ['fs:read', 'task:read'] }] }, 'authz.fs.uploads.policies.0.permissions.1'],
    ['a policy with the * permission glob', { mode: 'enforce', policies: [{ id: 'staff', permissions: ['*'] }] }, 'authz.fs.uploads.policies.0.permissions.0'],
    ['a policy with a permission glob over every resource', { mode: 'enforce', policies: [{ id: 'staff', permissions: ['*:read'] }] }, 'authz.fs.uploads.policies.0.permissions.0'],
    ['a policy whose permissions are not a list', { mode: 'enforce', policies: [{ id: 'staff', permissions: 'fs:read' }] }, 'authz.fs.uploads.policies.0.permissions'],
    ['a policy with a resource type outside fs, dir and file', { mode: 'enforce', policies: [{ id: 'staff', permissions: ['fs:read'], resourceTypes: ['file', 'task'] }] }, 'authz.fs.uploads.policies.0.resourceTypes.1'],
    ['operations that are a list', { mode: 'enforce', operations: ['fs:read'] }, 'authz.fs.uploads.operations'],
    ['an operation naming no permission', { mode: 'enforce', operations: { thumbnail: 'read' } }, 'authz.fs.uploads.operations.thumbnail'],
    ['an operation with an empty list', { mode: 'enforce', operations: { thumbnail: [] } }, 'authz.fs.uploads.operations.thumbnail'],
    ['the operations key constructor', { mode: 'enforce', operations: { constructor: ['fs:read'] } }, 'authz.fs.uploads.operations.constructor'],
    ['the operations key prototype', { mode: 'enforce', operations: { prototype: ['fs:read'] } }, 'authz.fs.uploads.operations.prototype'],
    ['an unknown list mode', { mode: 'enforce', list: 'all' }, 'authz.fs.uploads.list'],
  ];
  for (const [what, entry, path] of BAD) {
    it(`refuses ${what} at boot, naming ${path}`, async () => {
      expect(await refused(entry)).to.include(path);
    });
  }
});
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-fs && npx ts-mocha -p tsconfig.json test/config.test.ts`

Expected: the file fails to compile with `TS2305: Module '"../src/index.js"' has no exported member 'AUTHZ_FS_CONFIGURATION_SCHEMA'` (also `AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA`).

- [ ] **Step 4: Implement**

1. Create `access-config/schema.ts` (Step 1).
2. Write `packages/authz-fs/src/metadata/connection.ts` (whole file):

```ts
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

// Not under authz.fs: that section is keyed by filesystem name.
export const FS_METADATA_CONNECTION_KEY = 'authz.fsMetadata.connection';

export const FS_METADATA_DEFAULT_CONNECTION = 'default';

/** The ORM connection of OrmFileMetadataStore and of its migration: `authz.fsMetadata.connection`, else the default one. */
export function fsMetadataConnection(container: IContainer = DI.RootContainer): string {
  const configuration = container.get(Configuration) as Configuration | undefined;
  return (configuration?.get?.(['authz', 'fsMetadata', 'connection']) as string | null | undefined) ?? FS_METADATA_DEFAULT_CONNECTION;
}
```

   - The fallback stays (D2). The migration descriptor reads this connection with the root container, and tests run it on unvalidated configurations.
   - The type check is deleted.

3. Write `packages/authz-fs/src/access-config/index.ts` (whole file):

```ts
import { AuthzConfigError } from '@spinajs/authz';
import type { Permission, Policy, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { parseFsRef } from '../refs/index.js';

export * from './schema.js';

export type FsAccessMode = 'off' | 'audit' | 'enforce';

/** `authz.fs.<name>.signedUrl` (D9). */
export interface FsSignedUrlConfig {
  /** Cap on every signed URL's lifetime. */
  readonly maxTtlSeconds?: number;
  /** Lifetime when the caller asks for no `until`; default 900 (the S3 signer's own default). */
  readonly defaultTtlSeconds?: number;
}

/** `authz.fs.<name>` (design §13). */
export interface FsAccessConfig {
  readonly mode: FsAccessMode;
  /** Authz domain the guard asks; default 'root'. */
  readonly domain: string;
  /** Class name of a FileMetadataStore. */
  readonly metadata?: string;
  readonly stampOwner?: boolean;
  /** Class name of the FsPathResolver for this filesystem. */
  readonly resolver?: string;
  /** fs permission → action checked on the resolver's domain parent. */
  readonly inherit?: Readonly<Record<Permission, string>>;
  readonly signedUrl?: FsSignedUrlConfig;
  readonly policies?: readonly Policy[];
  /** Method → permission(s), added to or replacing the operation table. */
  readonly operations?: Readonly<Record<string, Permission | readonly Permission[]>>;
  readonly list?: 'dir' | 'each';
}

const OFF: FsAccessConfig = Object.freeze({ mode: 'off', domain: 'root' });

/**
 * `authz.fs.<fsName>` of the Configuration resolved in `container`, read on every call. A filesystem without an
 * entry is off (design §13: "any other fs: off").
 */
export function fsAccessConfig(fsName: string, container: IContainer = DI.RootContainer): FsAccessConfig {
  const all = fsSection(container, `authz.fs.${fsName}`);
  return all ? parseFsAccessConfig(fsName, Object.hasOwn(all, fsName) ? all[fsName] : undefined) : OFF;
}

/** Every `authz.fs.<name>` entry of the Configuration resolved in `container`, by filesystem name. */
export function fsAccessConfigs(container: IContainer = DI.RootContainer): ReadonlyMap<string, FsAccessConfig> {
  const all = fsSection(container, 'authz.fs');
  return new Map(Object.keys(all ?? {}).map((name) => [name, parseFsAccessConfig(name, all![name])]));
}

function fsSection(container: IContainer, at: string): Readonly<Record<string, unknown>> | undefined {
  const configuration = container.get(Configuration) as Configuration | undefined;
  if (!configuration || typeof configuration.get !== 'function') {
    throw new AuthzConfigError(`${at}: Configuration is not resolved; await DI.resolve(Configuration) first`);
  }
  return configuration.get<Record<string, unknown> | null | undefined>(['authz', 'fs']) ?? undefined;
}

/**
 * One `authz.fs.<fsName>` entry as the guard reads it; undefined is a missing entry (off). AUTHZ_FS_CONFIGURATION_SCHEMA
 * checks the entry. This fills the domain, gives a policy without a scope the filesystem, and copies inherit and
 * operations onto objects without a prototype, so no method name reads an inherited value.
 * @throws AuthzConfigError for a policy scope outside the filesystem: the schema cannot compare a value with its key
 */
export function parseFsAccessConfig(fsName: string, entry: unknown): FsAccessConfig {
  if (entry === undefined) return OFF;
  const e = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e, domain: e.domain ?? 'root' };
  if (e.inherit !== undefined) out.inherit = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, e.inherit));
  if (e.signedUrl !== undefined) out.signedUrl = Object.freeze({ ...(e.signedUrl as FsSignedUrlConfig) });
  if (e.operations !== undefined) out.operations = operationsOf(e.operations as Readonly<Record<string, Permission | readonly Permission[]>>);
  if (e.policies !== undefined) out.policies = scopedPolicies(e.policies as readonly Record<string, unknown>[], fsName);
  return Object.freeze(out) as unknown as FsAccessConfig;
}

function operationsOf(value: Readonly<Record<string, Permission | readonly Permission[]>>): Readonly<Record<string, Permission | readonly Permission[]>> {
  const out: Record<string, Permission | readonly Permission[]> = Object.create(null);
  for (const [method, permissions] of Object.entries(value)) out[method] = Array.isArray(permissions) ? Object.freeze([...(permissions as readonly Permission[])]) : (permissions as Permission);
  return Object.freeze(out);
}

/**
 * The policies of one filesystem stay on it (design §13: fs-only policies). The fs-abac model holds the policies of
 * every filesystem of a domain, so each policy gets the filesystem as its scope; a scope elsewhere (a resolver parent
 * such as a task, which is no ancestor of a path) would never match.
 */
function scopedPolicies(policies: readonly Record<string, unknown>[], fsName: string): readonly Policy[] {
  return Object.freeze(
    policies.map((policy, i) => {
      const scope = policy.scope ?? { type: 'fs', id: fsName };
      const ref = isRecord(scope) && typeof scope.id === 'string' ? parseFsRef(scope as unknown as ResourceRef) : undefined;
      if (ref?.fs !== fsName) throw new AuthzConfigError(`authz.fs.${fsName}.policies: policy ${show(policy.id ?? `#${i}`)}: scope ${show(scope)} is not this filesystem or a path of it`);
      return Object.freeze({ ...policy, scope });
    }),
  ) as unknown as readonly Policy[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
```

Deleted:
- `MODES`, `LISTS`, `KEYS`, `UNSAFE_KEYS`;
- `parseInherit`, `SIGNED_URL_KEYS`, `parseSignedUrl`, `FS_TYPES`;
- the permission and resource-type checks of `parsePolicies`;
- the checks of `parseOperations`;
- `nonEmptyString`;
- the "authz.fs must be an object" check;
- the `isPermission` and `FS_RESOURCE_TYPES` imports.

That is about 140 LOC.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-fs
npx ts-mocha -p tsconfig.json test/config.test.ts test/operations.test.ts test/fs-domain.test.ts test/guard.test.ts test/metadata-stores.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../email && npm test
```

Expected: all passing. The guard tests build their configs with `parseFsAccessConfig(name, entry)`, which still fills `domain: 'root'`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-fs/src/access-config/schema.ts packages/authz-fs/src/access-config/index.ts packages/authz-fs/src/metadata/connection.ts packages/authz-fs/test/config.test.ts
git commit -m "feat(authz-fs): authz.fs and authz.fsMetadata schemas in place of parseFsAccessConfig's checks"
```

---

### Task 5.15: authz-orm `authz.orm.domain` and `DbScopeAttributeStore`'s `authz.admin.connection` through `@Config`

**Files:**
- Create: `packages/authz-orm/src/schema.ts`
- Modify: `packages/authz-orm/src/index.ts:1-5` (one export line)
- Modify: `packages/authz-orm/src/middleware.ts`:
  - the import at line 3;
  - `domainName` at lines 82-87, deleted;
  - `AuthzQueryMiddleware` at lines 238-256;
  - `scopeFor` at lines 271-285;
  - `gate` at lines 484-490.
- Modify: `packages/authz-orm/src/scope-attributes/db-store.ts:1-11,34-50,136-151`
- Test (new): `packages/authz-orm/test/config.test.ts`
- Test (modify): `packages/authz-orm/test/scope-attributes/db-store.test.ts:95`

**Interfaces:**
- Consumes:
  - Task 5.2: `authz.admin.connection` defaults to `'default'`;
  - Task 5.1.
- Produces:
  - `AUTHZ_ORM_CONFIGURATION_SCHEMA`;
  - `AuthzOrmConfigBootstrapper`;
  - `AuthzQueryMiddleware.Domain`;
  - `DbScopeAttributeStore.Connection`.
- `scopeFor` and `gate` now take the domain as a getter.

- [ ] **Step 1: Schema additions**

`packages/authz-orm/src/schema.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

export const AUTHZ_ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-orm.configuration.schema.json',
  $configurationModule: 'authz.orm',
  description: 'ORM authorization configuration (authz.orm.*)',
  type: 'object',
  properties: {
    // The authz domain whose service scopes the ORM queries.
    domain: { type: 'string', minLength: 1, default: 'root' },
  },
};

@Injectable(Bootstrapper)
export class AuthzOrmConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ORM_CONFIGURATION_SCHEMA);
  }
}
```

- [ ] **Step 2: Failing tests**

`packages/authz-orm/test/config.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_ORM_CONFIGURATION_SCHEMA, DbScopeAttributeStore } from '../src/index.js';
import { AuthzQueryMiddleware } from '../src/middleware.js';

const expect = chai.expect;

describe('authz-orm configuration through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_ORM_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  it('AuthzQueryMiddleware reads authz.orm.domain of its container, root by default', async () => {
    const domainOf = (child: IContainer) => (bindConfiguration(new AuthzQueryMiddleware(), child) as unknown as { Domain: string }).Domain;
    expect(domainOf(await boot({ orm: { domain: 'tenant' } }))).to.equal('tenant');
    expect(domainOf(await boot({}))).to.equal('root');
  });

  it('refuses an empty authz.orm.domain at boot', async () => {
    expect(await violationPaths(boot({ orm: { domain: '' } }))).to.include('authz.orm.domain');
  });

  it('DbScopeAttributeStore reads authz.admin.connection of the container it is given', async () => {
    const connectionOf = (store: DbScopeAttributeStore) => (store as unknown as { Connection: string }).Connection;
    expect(connectionOf(new DbScopeAttributeStore({ container: await boot({ admin: { connection: 'attrs' } }) }))).to.equal('attrs');
    expect(connectionOf(new DbScopeAttributeStore({ container: await boot({}) }))).to.equal('default');
  });
});
```

Edit `packages/authz-orm/test/scope-attributes/db-store.test.ts:95`:
- `config.set(['authz', 'admin', 'connection'], undefined);` becomes `config.set(['authz', 'admin', 'connection'], 'default');`.
- That root configuration registers no authz schema.

- [ ] **Step 3: RED**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/config.test.ts`

Expected: the file fails to compile with `TS2305: Module '"../src/index.js"' has no exported member 'AUTHZ_ORM_CONFIGURATION_SCHEMA'`.

- [ ] **Step 4: Implement**

1. Create `src/schema.ts` (Step 1). In `packages/authz-orm/src/index.ts`, after `export * from './scope-attributes/index.js';`, add `export * from './schema.js';`.

2. `packages/authz-orm/src/middleware.ts`:
   1. Line 3 becomes `import { Config } from '@spinajs/configuration';`.
   2. Delete `domainName` (lines 82-87).
   3. Change `AuthzQueryMiddleware` to:

```ts
@Injectable(QueryMiddleware)
export class AuthzQueryMiddleware extends QueryMiddleware {
  public order = 100;

  @Config('authz.orm.domain')
  protected Domain: string;

  // Read when a scoped model needs it, not on every query.
  private readonly domain = (): string => this.Domain;

  afterQueryCreation(builder: QueryBuilder): void {
    guard(builder);
    scopeFor(builder, builder.Model as ModelClass | undefined, this.domain);
  }

  async beforeQueryExecution(builder: QueryBuilder): Promise<void> {
    // Builders the orm makes without afterQueryCreation (a many-to-many junction query) are shielded here.
    guard(builder);
    if (!scopes.has(builder)) scopeFor(builder, junctionOf(builder), this.domain);
    const scope = scopes.get(builder);
    await gate(builder, scope, this.domain);
```

   The rest of `beforeQueryExecution` stays.

   4. `scopeFor`:
      - It becomes `function scopeFor(builder: QueryBuilder, model: ModelClass | undefined, domain: () => string): void {`.
      - Its two `authz(domainName())` become `authz(domain())`.
   5. `gate`:
      - It becomes `async function gate(builder: QueryBuilder, scope: QueryScope | undefined, domain: () => string): Promise<void> {`.
      - Its `const service = (): AuthzService => authz(domainName());` becomes `const service = (): AuthzService => authz(domain());`.

   The string check of `domainName` is gone, and so is its `?? 'root'`. The schema gives the default.
   - A test configuration without the key passes `undefined`.
   - `authz(domain = 'root')` then falls back to root, as before.

3. `packages/authz-orm/src/scope-attributes/db-store.ts`:
   1. Line 4 becomes `import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';`.
   2. `DbScopeAttributeStoreOptions.connection` doc: `/** The ORM connection reads use; default: config authz.admin.connection. */`.
   3. The class head:

```ts
export class DbScopeAttributeStore extends WritableScopeAttributeStore {
  @Config(CONNECTION_KEY)
  protected Connection: string;

  constructor(private readonly opts: DbScopeAttributeStoreOptions = {}) {
    super();
    // Built with `new` for a container, it reads that container's Configuration, as when DI builds it there.
    if (opts.container) (this as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = opts.container;
  }
```

   4. `reader()`:

```ts
  private async reader(): Promise<OrmDriver> {
    const container = this.opts.container ?? DI.RootContainer;
    const name = this.opts.connection ?? this.Connection;
    const orm = (await container.resolve(Orm)) as Orm;
    const driver = orm.Connections.get(name);
    if (!driver) throw new AuthzConfigError(`DbScopeAttributeStore: ${CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
  }
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-orm
npx ts-mocha -p tsconfig.json test/config.test.ts test/scope-attributes/db-store.test.ts test/middleware.test.ts test/builders.test.ts test/late-registration.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../authz-queue && npm test
cd ../authz-rbac && npm test
cd ../authz-testing && npm test
cd ../configuration-http && npm test
cd ../http-socket && npm test
cd ../queue-http-progress && npm test
cd ../users && npm test
```

Expected: all passing. `canvas-c6` builds `new DbScopeAttributeStore({ container: db.container })`. That container's Configuration registers the core schema (Task 5.2), so it carries the default connection.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-orm/src/schema.ts packages/authz-orm/src/index.ts packages/authz-orm/src/middleware.ts packages/authz-orm/src/scope-attributes/db-store.ts packages/authz-orm/test/config.test.ts packages/authz-orm/test/scope-attributes/db-store.test.ts
git commit -m "refactor(authz-orm): authz.orm.domain and the scope attribute store's connection through @Config and the schemas"
```

---

### Task 5.16: authz-queue `authz.queue.domain` and `authz.bus.topic` through `@Config`

**Files:**
- Create: `packages/authz-queue/src/schema.ts`
- Modify: `packages/authz-queue/src/index.ts:1-4` (one export line)
- Modify:
  - `packages/authz-queue/src/hook/service.ts:1-10` (whole file)
  - `packages/authz-queue/src/hook/hook.ts:20-24`
  - `packages/authz-queue/src/job/job-resource.ts:1-27`
  - `packages/authz-queue/src/bus/change-bus.ts:3-4,53-62,145-151`
- Test (new): `packages/authz-queue/test/config.test.ts`

**Interfaces:**
- Consumes: Task 5.1.
- Produces:
  - `AUTHZ_QUEUE_CONFIGURATION_SCHEMA` (`authz.queue`);
  - `AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA` (`authz.bus`, `topic` only; the core schema leaves `authz.bus` open);
  - `AuthzQueueConfigBootstrapper`;
  - `authzFor(domain: string)`, whose domain argument is now required;
  - `AuthzQueueTrackingHook.Domain` and `QueueChangeBus.Topic`.

**Where `@Config` cannot apply:**
- `authzFor` is a free function.
- Its two callers are DI classes, so they read the value through `@Config` and pass it on.

- [ ] **Step 1: Schema additions**

`packages/authz-queue/src/schema.ts`:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

const name = { type: 'string', minLength: 1 };

export const AUTHZ_QUEUE_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-queue.configuration.schema.json',
  $configurationModule: 'authz.queue',
  description: 'Queue authorization configuration (authz.queue.*)',
  type: 'object',
  properties: {
    // The authz domain whose principal a message carries and whose runAs its handler uses.
    domain: { ...name, default: 'root' },
  },
};

// authz.bus belongs to the core schema, which leaves it open; the topic is the queue bus's own key.
export const AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-queue-bus.configuration.schema.json',
  $configurationModule: 'authz.bus',
  description: 'Queue change bus configuration (authz.bus.topic)',
  type: 'object',
  properties: { topic: name },
};

@Injectable(Bootstrapper)
export class AuthzQueueConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_QUEUE_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA);
  }
}
```

`authz.bus.topic` gets no default: without a topic, `AuthzChangeEvent` keeps the routing that the app or the queue gives it.

- [ ] **Step 2: Failing tests**

`packages/authz-queue/test/config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA, AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AuthzQueueConfigBootstrapper, AuthzQueueHook, AuthzQueueTrackingHook, QueueChangeBus } from '../src/index.js';

describe('authz-queue configuration through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const read = (instance: object, child: IContainer, key: string): unknown => (bindConfiguration(instance, child) as unknown as Record<string, unknown>)[key];

  it('the hooks read authz.queue.domain of their container, root by default', async () => {
    const tenant = await boot({ queue: { domain: 'tenant' } });
    expect(read(new AuthzQueueHook(), tenant, 'Domain')).to.equal('tenant');
    expect(read(new AuthzQueueTrackingHook(), tenant, 'Domain')).to.equal('tenant');
    expect(read(new AuthzQueueTrackingHook(), await boot({}), 'Domain')).to.equal('root');
  });

  it('QueueChangeBus reads authz.bus.topic, none by default', async () => {
    expect(read(new QueueChangeBus(), await boot({ bus: { topic: '/topic/authz' } }), 'Topic')).to.equal('/topic/authz');
    expect(read(new QueueChangeBus(), await boot({}), 'Topic')).to.equal(undefined);
  });

  it('refuses an empty domain or topic at boot', async () => {
    expect(await violationPaths(boot({ queue: { domain: '' } }))).to.include('authz.queue.domain');
    expect(await violationPaths(boot({ bus: { topic: '' } }))).to.include('authz.bus.topic');
  });

  it('the bootstrapper registers both schemas', () => {
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new AuthzQueueConfigBootstrapper().bootstrap();
    try {
      expect(DI.RootContainer.Cache.get(KEY)).to.include.members([AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA]);
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      for (const schema of [AUTHZ_QUEUE_CONFIGURATION_SCHEMA, AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA]) list.splice(list.indexOf(schema), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
  });
});
```

- [ ] **Step 3: RED**

Run: `cd packages/authz-queue && npx ts-mocha -p tsconfig.json test/config.test.ts`

Expected: the file fails to compile with `TS2305: Module '"../src/index.js"' has no exported member 'AUTHZ_QUEUE_CONFIGURATION_SCHEMA'` (also `AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA` and `AuthzQueueConfigBootstrapper`).

- [ ] **Step 4: Implement**

1. Create `src/schema.ts` (Step 1). In `packages/authz-queue/src/index.ts`, add `export * from './schema.js';`.

2. `packages/authz-queue/src/hook/service.ts` (whole file):

```ts
import { DI } from '@spinajs/di';
import { AuthzDomains } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';

/** The AuthzService of `domain`: the `authz.queue.domain` its caller reads. */
export async function authzFor(domain: string): Promise<AuthzService> {
  return (await DI.resolve(AuthzDomains)).service(domain);
}
```

3. `packages/authz-queue/src/hook/hook.ts:23`: `@Config('authz.queue.domain', { defaultValue: 'root' })` becomes `@Config('authz.queue.domain')`. The schema gives the default.

4. `packages/authz-queue/src/job/job-resource.ts`:
   1. Add `import { Config } from '@spinajs/configuration';`.
   2. Change `AuthzQueueTrackingHook` to:

```ts
/** The queue's own job-row queries run as SYSTEM: the job's principal may not touch the table. */
@Injectable(QueueTrackingHook)
export class AuthzQueueTrackingHook extends QueueTrackingHook {
  @Config('authz.queue.domain')
  protected Domain: string;

  async aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    return (await authzFor(this.Domain)).runAs(SYSTEM, 'queue:tracking', next);
  }
}
```

5. `packages/authz-queue/src/bus/change-bus.ts`:
   1. Line 4 becomes `import { Config, Configuration } from '@spinajs/configuration';`.
   2. In `QueueChangeBus`, after `protected retryMs = 5000;`, add:

```ts
  @Config('authz.bus.topic')
  protected Topic: string | undefined;
```

   3. Replace `route()` (lines 145-151) with:

```ts
  /** `authz.bus.topic` becomes the channel of `AuthzChangeEvent` unless `queue.routing` already routes it. */
  private route(): void {
    const cfg = DI.get(Configuration);
    if (!cfg || cfg.get<unknown>(['queue', 'routing', AuthzChangeEvent.name]) !== undefined) return;
    const topic = this.Topic;
    if (topic === undefined) return;
    cfg.set(['queue', 'routing', AuthzChangeEvent.name], { channel: topic });
  }
```

   - The string check is deleted.
   - The `Configuration` read of `queue.routing` stays. It is the queue's key, which this code writes into, not an authz value.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz-queue
npx ts-mocha -p tsconfig.json test/config.test.ts test/bus.test.ts test/hook.test.ts test/job-scope.test.ts
npm test
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
cd ../email && npm test
cd ../http-socket && npm test
cd ../queue-http-progress && npm test
cd ../users && npm test
```

Expected: all passing.
- The authz-queue and queue-http-progress harnesses set `authz.queue.domain`.
- email and http-socket override `service()`.
- users' `principal-factory.test.ts` imports authz-queue before its `beforeEach` runs the bootstrappers, so the schema default applies to its FrameworkConfiguration.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-queue/src/schema.ts packages/authz-queue/src/index.ts packages/authz-queue/src/hook/service.ts packages/authz-queue/src/hook/hook.ts packages/authz-queue/src/job/job-resource.ts packages/authz-queue/src/bus/change-bus.ts packages/authz-queue/test/config.test.ts
git commit -m "refactor(authz-queue): authz.queue.domain and authz.bus.topic through @Config and the schemas"
```

---

## Self-review

**Coverage.** Every Phase 5 inventory row maps to a task: see "Rows and where `@Config` cannot apply".

**Conflicts the inventory names.**
- `groupPrincipal`: Task 5.11.
- `authz.admin.connection` defaults: Tasks 5.2, 5.7, 5.15.
- `storeConnection` fallback: Task 5.7, D8.

**`ctx.config` decision.** D2, applied in Tasks 5.11 and 5.13.

**Kept in code** (D5):
- `TokenRolePolicy` lookup (5.12);
- ORM connection existence (5.7, 5.13, 5.15);
- role-graph checks of config roles (5.11);
- the fs policy scope check against its key (5.14);
- the link secret's presence (5.10);
- the abac unknown-store throw (5.13).

**Tests boot through a child Configuration.** Each task's new tests boot through `bootConfiguration` (Task 5.1), which resolves the child's Configuration before any read. They assert `violations[].path`.

**Risks.**
- Phase 4's exact `admin` block and root defaults: listed in Prerequisites.
- Suites that resolve a Configuration without the authz schemas: each task seeds the ones found (telemetry, users, users-http, the rbac and canvas test databases, the in-memory `TestConfiguration` resets). A dependant suite not listed that fails on an absent default needs the same one-line seed.
