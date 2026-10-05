# Configuration Phase 4: authz core through `@Config` and the schema

**Goal:** The classes of `packages/authz/src` stop reading `Configuration` by hand and stop validating by hand. Each takes its keys from `@Config`, and every value rule lives in `AUTHZ_CONFIGURATION_SCHEMA` (`packages/authz/src/host/config/schema.ts`). A bad value fails the boot with `InvalidConfiguration`, and `violations[].path` is the full configuration path of the bad value. Root-level defaults move into the schema. Defaults never go inside `authz.domains.<n>`, because a domain inherits every unset key from its parent.

**Scope:** the five rows of `.superpowers/sdd/phase-4-inventory.md`, plus one prerequisite task (4.1). The authz host tests use `testHost`'s `TestConfiguration`, which never validates, so 4.1 adds a way to boot a validating child Configuration. Rows 1 and 2 share `readDomainConfig` and `packages/authz-orm/src/principal.ts`, so Task 4.2 covers both.

**References (read before starting a task):**
- `.superpowers/sdd/global-constraints.md`: English comments and messages, one commit per task, commands run from the package directory, rebuild a changed package before its dependants read `lib/`, keep each file's line endings, value checks go to the schema, and code keeps only DI lookups, compiling and the merge across authz domains.
- `.superpowers/sdd/mechanism-notes.md`: how `@Config` and validation work now. It overrides older plan text.
- `.superpowers/sdd/recipe.md` and `.superpowers/sdd/task-5-brief.md`: the per-class recipe and the shape of a task.

**Facts verified against the current code (2026-10-05, HEAD `28ea6fa1d` plus the uncommitted Phase 0 follow-up in `packages/configuration`):**
- **All five inventory rows still apply.** The current locations:
  - `DefaultAuthzService.boot`: `host/service.ts:303`. The Configuration is read at 323-328, and `ModelInitContext.config` reads `authz.<model>.*` at 543.
  - `readDomainConfig`: `host/config/domain-config.ts:62-175`.
  - `DefaultAuthzDomains.configuredParent`: `host/domains.ts:168-182`.
  - authz-orm `lineageOf`: `principal.ts:9-21`.
  - `DefaultAuthzAdmin.env`: `admin/admin.ts:368-395`.
  - `assertAdminPermission`: `admin/permit.ts:28-35`.
  - `readAdminConfig`: `admin/config.ts:30-72`.
  - `ConfigScopeAttributeSchemas`: `admin/scope-attributes/schemas.ts:34-56`.
  - `isProduction`: `host/env.ts:4-15`. Its only callers are in authz-http: `access/policy.ts:146` and `explain/source.ts:21`.
- **Reads the inventory does not list. Task 4.2 handles all of them.**
  - `checkLegacyKeys` (`host/config/legacy-keys.ts:68-81`) type-checks `authz.config` and `authz.config.rejectLegacyKeys`. The boot calls it.
  - `readDomainConfig` has callers outside authz: authz-http `access/policy.ts:151`, `domains.ts:37` and `fields.ts:35`, and authz-orm `principal.ts:26`. Their signature changes mechanically here. Phase 5 moves them to `@Config`.
  - `ConfigGetter` has no user left once authz-orm stops using it, so 4.2 deletes it.
- **The `@Config` getter is synchronous.** It calls `container.get(Configuration)`, which reads the cache only and walks to the parents.
  - So `@Config` does apply to `DefaultAuthzDomains.create()`, even though `create()` is sync. The only requirement is a resolved root Configuration, which `create()` already needs today.
  - The singleton is built in root, so it reads root as it does today.
  - DI assigns the hidden key (`CONFIGURATION_CONTAINER_KEY` in the working copy of `packages/configuration/src/decorators.ts`) after the constructor runs. No constructor here reads an `@Config` property. If HEAD still exports `CONFIGURATION_INJECTION_KEY` when a task runs, use the name the file exports.
- **Where the authz configuration comes from today:**
  - `DefaultAuthzService` and `DefaultAuthzAdmin` are `@PerChildInstance`. They read the Configuration of the domain container they are resolved in, which is the nearest one in its lineage.
  - Domain containers are children of root and register no Configuration in an app.
  - So `@Config` on these classes reads exactly what `container.resolve(Configuration)` read before.
- **The authz tests import `@spinajs/authz` from `lib/`.** Rebuild authz (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) before every RED and GREEN run.
- **Running one test file.** `.mocharc.host.json` and `.mocharc.admin.json` merge their `spec` with the files on the command line (checked: `--config .mocharc.host.json test/host/domains.test.ts` runs all 298 host tests), and `.mocharc.json` ignores `test/host/**` and `test/admin/**`. One file runs with `--no-config`. Every command below uses:
  `MOCHA` = `npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000`
- **ts-node type-checks test files.** A test that calls an API the lib does not have yet fails RED as `TSError: ⨯ Unable to compile TypeScript`, and the error names it.
- **The Ajv options of the app:** `coerceTypes`, `useDefaults`, `removeAdditional: true` (strips only under `additionalProperties: false`), `allErrors` and `$data`.
  - `coerceTypes` turns `'5'` into `5` and `1` into `true`. The test cases use values that do not coerce (`'no'`, `'sometimes'`, `{}`, arrays).
  - Ajv inserts a copy of each `default`, so a frozen default from `AUTHZ_DEFAULTS` is safe.
- **Violation paths:**
  - They join with dots, and a domain name with a dot stays one segment in the source data, for example `authz.domains.a.b.engine.explain`.
  - `required`, `propertyNames` and `additionalProperties` errors append the key.
  - The error of a failed domain boot is an `AuthzConfigError` whose `cause` is the `InvalidConfiguration`, because `DefaultAuthzService.resolve` wraps every boot error.

## Design decisions

1. **Defaults and inheritance.**
   - A schema `default` appears only at the root level, through `rootDefault(root, value)` in `schema.ts`. The domain variant of each shared section has none.
   - The root defaults are derived from `AUTHZ_DEFAULTS`, and the admin ones from `ADMIN_DEFAULTS`, so they cannot drift.
   - `AUTHZ_DEFAULTS` stays as the merge base. A domain merges `AUTHZ_DEFAULTS`, then root, then each `authz.domains.<n>` of its lineage.
2. **`readDomainConfig(tree, lineage)` only merges.**
   - It takes the `authz` tree, not a getter, and indexes it with own-property lookups. The lookup helper `configAt` is exported.
   - It no longer type-checks, because the schema validates every level. A level that is not an object is skipped.
   - The signature change reaches authz-http and authz-orm in the same commit.
3. **How `DefaultAuthzService` gets the tree:** `@Config('authz') protected Config: unknown`, the whole tree.
   - A dotted path such as `authz.domains.a.b` cannot address a domain whose name contains dots. Lodash would split it.
   - Being `@PerChildInstance`, the service gets the domain container as its hidden key, so the getter reads the domain container's Configuration, the same one as before.
   - `boot()` still does `await container.resolve(Configuration)` before the first read. The getter reads only a resolved Configuration, and a domain container may register its own (the tests do).
   - `ModelInitContext.config` reads `this.Config` on every call (live, as before) through `configAt`.
4. **Fallbacks for Configurations that skip the schema.** `testHost`'s `TestConfiguration`, which every authz and dependant test uses, never applies schema defaults. So the code keeps one fallback per key, taken from the same constant the schema default comes from:
   - `AUTHZ_DEFAULTS` as the merge base;
   - `@Config(..., { defaultValue: ADMIN_DEFAULTS.x })`;
   - `defaults = {}` in `ConfigScopeAttributeSchemas`.
   - Follow-up, out of scope: make `TestConfiguration` apply the schemas, then drop these fallbacks.
5. **Where `@Config` cannot apply, and what is used instead:**
   - `assertAdminPermission` is a free function and its container comes from the call context. It resolves the admin container's Configuration and reads the validated `authz.admin.permissions` without checks.
   - authz-orm `domainConfig` / `maxDelegationOf` / `serviceConfig` are synchronous module functions. They keep `DI.get(Configuration)` of root. Phase 5 owns them.
   - The authz-http `readDomainConfig` callers are module functions. Phase 5 owns them.
6. **What stays in code because a schema cannot express it:**
   - **DI lookups:**
     - the guard, backend, bus and audit class names (`DefaultAuthzAdmin.named`, `DefaultAuthzService.pick`);
     - a configured parent that must exist and match the `create()` argument (runtime domain state).
   - **Graph and duplicate checks:**
     - a cycle across `authz.domains.<n>.parent` entries (`configuredLineage`);
     - duplicate scope types across contributors (`contributedSchemas`).
   - **Compiling:** a scope attribute schema must compile (`schemaValidator`).
   - **Merging across authz domains:** `readDomainConfig`.
   - **The environment:** the `isProduction` fallback, because a schema cannot read `APP_ENV`.
7. **Conflicts resolved:**
   - **Defaults inside domains versus inheritance:** root-only defaults, as in decision 1.
   - **`authz.scopes.attributes: null`:** the code returns nothing for `null`. That is the only way to turn off a section a shipped config sets, because config merges never remove a key. The schema allows `['object', 'null']`, as authn does.
   - **`privilegedPermission`:** `readGuardConfig` demands it at the first guard call while a self-lockout or last-holder switch is on, and an unset switch counts as on. The schema enforces the same rule at boot whenever an `authz.admin.guard` section exists. Phase 5 then deletes `readGuardConfig`.
   - **`authz.admin.connection`:** Phase 5 wants `default: 'default'`. authz-rbac `storeConnection` names "the ORM default connection" in its error when neither connection key is set, and a schema default would make that error name `authz.admin.connection` instead. The block gets the key with no default. Phase 5 decides.
   - **authz-orm "reuses DefaultAuthzDomains":** its fallback runs exactly when no `DefaultAuthzDomains` exists yet (the "configured parents before the host created its domains" test). So it reuses the exported `configuredLineage` from `host/domains.ts`, not the instance.
   - **`isProduction`:**
     - The `typeof` check goes. The callers pass their `@Config('configuration.isProduction')` value.
     - The environment fallback stays for `undefined`, because a CJS app or a test Configuration may not load the shipped `configuration` module.
     - Without the fallback, an explain trace could leak in production.

**Behaviour changes (flag them in the commit bodies):**
- A bad authz value fails the Configuration boot with `InvalidConfiguration`. Before, it failed with an `AuthzConfigError` at the service boot or at the first admin call.
- Admin guard: a configured `authz.admin.guard` with a self-lockout or last-holder switch on needs `privilegedPermission` at boot. Before, it was needed at the first `DefaultAdminGuard` or `AccountGuard` call. A custom guard section that ignores the switches must set both to `false` or name the permission.
- `authz.domains.<n>.parent` must be a domain name (`^[A-Za-z0-9_.-]{1,64}$`).
- `configuration.isProduction` set to a non-boolean no longer falls back to the environment.

## Task order and parallelism

```
4.1 harness (first, alone)
  then: 4.2 domain tree (rows 1 + 2)
  then in parallel: 4.3 admin (row 3)   4.4 scope attributes (row 4)   4.5 isProduction (row 5)
```

Why this order:
- 4.1 adds the test helpers every later task uses.
- 4.2 must come before the rest:
  - it rewrites `schema.ts` whole;
  - it changes `readDomainConfig`, which `admin.ts` (4.3) calls;
  - it edits `authz-http/src/access/policy.ts` three lines below the `isProduction` call (4.5).
- 4.3, 4.4 and 4.5 touch disjoint `src` and test files:
  - 4.3: `admin/config.ts`, `admin.ts`, `permit.ts`, `test/host/config.test.ts`, `test/admin/execute.test.ts`;
  - 4.4: `scope-attributes/schemas.ts`, `test/admin/scope-attributes.test.ts`;
  - 4.5: `host/env.ts`, `test/host/defaults.test.ts`, authz-http `policy.ts:2,50,146` and `explain/source.ts`.
- 4.3 and 4.4 both edit `schema.ts`, but at separate anchors, so the merge is trivial:
  - 4.3 adds an import line and the `admin` constants after `const audit`, and `admin` after `bus` in the root `properties`;
  - 4.4 adds `const scopes` after `const permissions`, and `scopes` after `principals`.
- Run the parallel tasks in separate worktrees. Step 5 (the dependant runs) goes one task at a time, never in parallel: every dependant reads authz from `lib/`, which each task rebuilds.

Before Task 4.1, record a baseline: run `npm test` in `packages/authz`, `authz-orm`, `authz-abac`, `authz-rbac`, `authz-http`, `authz-fs`, `authz-testing` and `users` at HEAD, and note the failing tests. In every Step 5, "green" means no failure beyond that baseline.

---

### Task 4.1: The host tests boot a validating child Configuration with the authz schema

**Files:**
- Modify: `packages/authz/test/host/support.ts:1-22`. Rewrite the whole file: the old content plus the helpers.
- Modify: `packages/authz/test/host/config.test.ts`:
  - imports at lines 1-10;
  - a new `describe` inserted before `describe('AuthzConfigBootstrapper'` (line 381).

**Interfaces:**
- Consumes: `FrameworkConfiguration` and `InvalidConfiguration` (`violations[].path`) from `@spinajs/configuration`, and `AUTHZ_CONFIGURATION_SCHEMA` from `@spinajs/authz`.
- Produces, in `test/host/support.ts`, for Tasks 4.2-4.4:
  - `configurationOf(values)`;
  - `registerConfiguration(container, values)` (sync, for registration hooks);
  - `childWith(values)`;
  - `violationPaths(promise)` (accepts the error itself or the `cause` of a boot error);
  - `violationsOf(values)`.

- [ ] **Step 1: Schema additions**

None. The harness applies the schema as it stands.

- [ ] **Step 2: Failing tests**

In `packages/authz/test/host/config.test.ts`, change line 8 (`import { DI } from '@spinajs/di';`) to:

```ts
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
```

and add after line 10 (`import { join } from 'node:path';`):

```ts
import { childWith, violationsOf } from './support.js';
```

Insert before `describe('AuthzConfigBootstrapper', () => {`:

```ts
describe('authz configuration through a child Configuration', function () {
  this.timeout(30000);
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function booted(values: Record<string, unknown>) {
    const { child, configuration } = await childWith(values);
    children.push(child);
    return configuration;
  }

  it('validates the values of the child with the authz schema, naming every full path', async () => {
    expect(await violationsOf({ authz: { engine: { modelTimeoutMs: 0 }, domains: { 'a.b': { cache: { ttlSeconds: -1 } } } } })).to.include.members(['authz.engine.modelTimeoutMs', 'authz.domains.a.b.cache.ttlSeconds']);
  });

  it('boots a valid child Configuration with its values', async () => {
    const configuration = await booted({ authz: { engine: { explain: true } } });
    expect(configuration.get(['authz', 'engine', 'explain'])).to.equal(true);
  });
});
```

- [ ] **Step 3: RED**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/config.test.ts
```

Expected: `TSError: ⨯ Unable to compile TypeScript`, with `TS2305: Module '"./support.js"' has no exported member 'childWith'` and the same for `violationsOf`.

- [ ] **Step 4: Implement**

Replace `packages/authz/test/host/support.ts` with:

```ts
import * as chai from 'chai';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';

import { AUTHZ_CONFIGURATION_SCHEMA, AuthzService } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

type Path = string | readonly string[];

const segments = (path: Path): string[] => (Array.isArray(path) ? [...path] : (path as string).split('.').filter((s) => s !== ''));

// The kit owns the DI root state (install, root registrations), which hostHarness shares.
export const { config, installHost, uninstallHost, resetHost, rootDomains, domains, disposeDomains, resetRoot, registerInRoot, instance } = testHost;

export const setConfig = (path: Path, value: unknown): void => config().set(segments(path), value);
export const clearConfig = (path: Path): void => config().unset(path);
export const resetConfig = (): void => config().reset();

export async function rootService(): Promise<AuthzService> {
  return DI.resolve(AuthzService);
}

/**
 * A Configuration of `values` alone, without file sources, so the schemas see exactly these values. testHost's
 * TestConfiguration never validates, so a test of the schema or its defaults boots one of these in a child container.
 */
export function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class AuthzTestConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

/** Registers the authz schema and a Configuration of `values` in `container`; the schema applies when that Configuration resolves. */
export function registerConfiguration(container: IContainer, values: Record<string, unknown>): void {
  container.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  container.register(configurationOf(values)).as(Configuration);
}

/** A child of root with its own resolved Configuration of `values`; the caller disposes the child. */
export async function childWith(values: Record<string, unknown>): Promise<{ child: IContainer; configuration: Configuration }> {
  const child = DI.RootContainer.child();
  try {
    registerConfiguration(child, values);
    return { child, configuration: (await child.resolve(Configuration)) as Configuration };
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

/** The violation paths of the InvalidConfiguration `p` rejects with, itself or as the cause of an authz boot error. */
export async function violationPaths(p: Promise<unknown>): Promise<string[]> {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  const invalid = error instanceof InvalidConfiguration ? error : (error as { cause?: unknown } | undefined)?.cause;
  chai.expect(invalid, `the configuration is refused (got ${String(error)})`).to.be.instanceOf(InvalidConfiguration);
  return (invalid as InvalidConfiguration).violations.map((v) => v.path);
}

/** The violation paths the authz schema reports for `values`, from a child Configuration that fails to boot. */
export async function violationsOf(values: Record<string, unknown>): Promise<string[]> {
  const child = DI.RootContainer.child();
  try {
    registerConfiguration(child, values);
    return await violationPaths(Promise.resolve().then(() => child.resolve(Configuration)));
  } finally {
    await child.dispose();
  }
}

export type { IContainer };
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/config.test.ts
npm test
```

Expected: all pass. No dependant run: the change is test-only, and `lib/` does not change.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/test/host/support.ts packages/authz/test/host/config.test.ts
git commit -m "test(authz): boot a validating child Configuration with the authz schema in the host tests"
```

---

### Task 4.2: The domain tree through `@Config`: `DefaultAuthzService`, `readDomainConfig`, `DefaultAuthzDomains` and authz-orm's lineage (rows 1 and 2)

**Files:**
- Modify: `packages/authz/src/host/config/schema.ts:1-111` (the whole file)
- Modify: `packages/authz/src/host/config/defaults.ts:3` (doc comment)
- Modify: `packages/authz/src/host/config/domain-config.ts:1-175` (the whole file)
- Modify: `packages/authz/src/host/config/legacy-keys.ts:68-81`
- Modify: `packages/authz/src/host/service.ts`: lines 3, 25-27, after 111, 323-328, 404, 515 and 543
- Modify: `packages/authz/src/host/domains.ts`: lines 1-3, after 7, 36, after 44, 57 and 168-182
- Modify: `packages/authz/src/admin/admin.ts:390` (the `readDomainConfig` call only; 4.3 rewrites `env()`)
- Modify: `packages/authz-http/src/access/policy.ts:151`, `packages/authz-http/src/domains.ts:37`, `packages/authz-http/src/fields.ts:35`
- Modify: `packages/authz-orm/src/principal.ts:1-27`
- Test: `packages/authz/test/host/config.test.ts`, `packages/authz/test/host/service.test.ts`, `packages/authz/test/host/domains.test.ts`

**Interfaces:**
- Consumes: the Task 4.1 helpers, `@Config`, `CONFIGURATION_CONTAINER_KEY`, and the lineage, default and violation behaviour of Phase 0.
- Produces:
  - `readDomainConfig(tree: unknown, lineage: readonly string[]): DomainConfig`, which only merges;
  - `configAt(tree, path)`;
  - `configuredParent(tree, name)` and `configuredLineage(tree, name)` in `host/domains.ts`;
  - `checkLegacyKeys(rbac: unknown, reject: boolean, log)`;
  - `DefaultAuthzService.Config` and `DefaultAuthzDomains.Config` (the `authz` tree);
  - the root-level schema defaults and the `parent` pattern.
- Removes: `ConfigGetter`, the type checks of `readDomainConfig` and `checkLegacyKeys`, the string check of `configuredParent` and of authz-orm `lineageOf`.

- [ ] **Step 1: Schema additions**

Replace `packages/authz/src/host/config/schema.ts` with the file below. The new parts:
- `rootDefault`;
- the `(root: boolean)` section builders: `combine`, `engine`, `fields`, `cache`, `audit`;
- `default` on the root `principals`, `principals.anonymous`, `principals.anonymous.enabled`, `config` and `config.rejectLegacyKeys`;
- `parent: { type: 'string', pattern: DOMAIN_NAME }`.

```ts
import { AUTHZ_DEFAULTS } from './defaults.js';

const D = AUTHZ_DEFAULTS;

const stringList = { type: 'array', items: { type: 'string' } };

/** What AuthzDomains.create accepts as a domain name. */
const DOMAIN_NAME = '^[A-Za-z0-9_.-]{1,64}$';

// A default only at the root: inside authz.domains.<n> an unset key must stay unset, or the domain would stop inheriting it from its parent.
const rootDefault = (root: boolean, value: unknown): { default?: unknown } => (root ? { default: value } : {});

const combineEntry = {
  type: 'object',
  properties: {
    algorithm: { type: 'string', minLength: 1 },
    models: stringList,
  },
  required: ['algorithm'],
};

const combine = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, D.combine),
  properties: {
    default: combineEntry,
    types: { type: 'object', additionalProperties: combineEntry },
  },
  required: ['default'],
});

const permissions = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      fields: { type: 'boolean' },
      types: stringList,
      implies: stringList,
    },
  },
};

const engine = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    explain: { type: 'boolean', ...rootDefault(root, D.engine.explain) },
    modelTimeoutMs: { type: 'integer', minimum: 1, ...rootDefault(root, D.engine.modelTimeoutMs) },
    maxDelegation: { type: 'integer', minimum: 0, ...rootDefault(root, D.engine.maxDelegation) },
  },
});

const fields = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    neverRead: { ...stringList, ...rootDefault(root, D.fields.neverRead) },
    write: {
      type: 'object',
      ...rootDefault(root, {}),
      properties: { mode: { type: 'string', enum: ['strip', 'reject'], ...rootDefault(root, D.fields.write.mode) } },
    },
  },
});

const cache = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    maxEntries: { type: 'integer', minimum: 0, ...rootDefault(root, D.cache.maxEntries) },
    ttlSeconds: { type: 'number', minimum: 0, ...rootDefault(root, D.cache.ttlSeconds) },
  },
});

const audit = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    denials: { type: 'boolean', ...rootDefault(root, D.audit.denials) },
    runAs: { type: 'boolean', ...rootDefault(root, D.audit.runAs) },
    unscoped: { type: 'boolean', ...rootDefault(root, D.audit.unscoped) },
    service: { type: 'string', minLength: 1 },
  },
});

// The root object stays open: sections such as authz.http or authz.rbac belong to other packages
// and the configuration's removeAdditional would strip them.
export const AUTHZ_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz.configuration.schema.json',
  $configurationModule: 'authz',
  description: 'Authorization configuration (authz.*)',
  type: 'object',
  properties: {
    permissions,
    combine: combine(true),
    domains: {
      type: 'object',
      propertyNames: { pattern: DOMAIN_NAME, not: { const: 'root' } },
      additionalProperties: {
        type: 'object',
        properties: {
          parent: { type: 'string', pattern: DOMAIN_NAME },
          combine: combine(false),
          disable: stringList,
          permissions,
          engine: engine(false),
          fields: fields(false),
          cache: cache(false),
          audit: audit(false),
        },
      },
    },
    principals: {
      type: 'object',
      default: {},
      properties: {
        anonymous: { type: 'object', default: {}, properties: { enabled: { type: 'boolean', default: D.principals.anonymous.enabled } } },
        roleSwitch: { type: 'object', properties: { requirePassword: stringList } },
      },
    },
    fields: fields(true),
    engine: engine(true),
    cache: cache(true),
    audit: audit(true),
    bus: { type: 'object', properties: { service: { type: 'string', minLength: 1 } } },
    config: { type: 'object', default: {}, properties: { rejectLegacyKeys: { type: 'boolean', default: D.config.rejectLegacyKeys } } },
  },
};
```

- [ ] **Step 2: Failing tests**

**`packages/authz/test/host/config.test.ts`**

Imports. Replace the `@spinajs/authz` import (line 7) with:

```ts
import { AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_DEFAULTS, readDomainConfig, configAt, AUTHZ_LEGACY_KEYS, checkLegacyKeys, findLegacyKeys, AuthzConfigError, AuthzConfigBootstrapper } from '@spinajs/authz';
```

Delete the `getter` helper (lines 15-17).

In `describe('authz config schema')`, replace the test `it('accepts an empty config and adds no defaults', ...)` with:

```ts
  it('fills the root-level defaults from AUTHZ_DEFAULTS, and none inside a domain', () => {
    const cfg: any = { domains: { fs: { engine: {} } } };
    expect(validate(cfg).ok).to.equal(true);
    expect(cfg).to.deep.include({
      combine: AUTHZ_DEFAULTS.combine,
      engine: AUTHZ_DEFAULTS.engine,
      fields: AUTHZ_DEFAULTS.fields,
      cache: AUTHZ_DEFAULTS.cache,
      audit: AUTHZ_DEFAULTS.audit,
      principals: AUTHZ_DEFAULTS.principals,
      config: AUTHZ_DEFAULTS.config,
    });
    expect(cfg.domains).to.deep.equal({ fs: { engine: {} } });
  });
```

In `it('rejects wrong types, each for its own reason', ...)`, add after the `permissions` line:

```ts
    fails({ domains: { fs: { parent: 'a b' } } }, '/domains/fs/parent', 'pattern');
```

Replace the whole `describe('readDomainConfig', () => { ... });` block (lines 109-273 of HEAD) with:

```ts
describe('readDomainConfig', () => {
  it('returns the defaults without an authz tree', () => {
    const c = readDomainConfig(undefined, ['root']);
    expect(c.domain).to.equal('root');
    expect(c.parent).to.equal(undefined);
    expect(c.permissions).to.deep.equal({});
    expect(c.disable).to.deep.equal([]);
    expect(c.combine).to.deep.equal({ default: { algorithm: 'deny-overrides' } });
    expect(c.engine).to.deep.equal({ explain: false, modelTimeoutMs: 2000, maxDelegation: 2 });
    expect(c.fields).to.deep.equal({ neverRead: ['Password'], writeMode: 'strip' });
    expect(c.cache).to.deep.equal({ maxEntries: 10000, ttlSeconds: 60 });
    expect(c.audit).to.deep.equal({ denials: true, runAs: true, unscoped: true });
    expect(c.bus).to.deep.equal({});
    expect(c.principals).to.deep.equal({ anonymousEnabled: true });
  });

  it('reads root-only values', () => {
    const c = readDomainConfig(validConfig(), ['root']);
    expect(Object.keys(c.permissions)).to.deep.equal(['fs.read', 'fs.list']);
    expect(c.combine.types!.File.algorithm).to.equal('first-applicable');
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 1000, maxDelegation: 0 });
    expect(c.fields).to.deep.equal({ neverRead: ['Password'], writeMode: 'reject' });
    expect(c.cache).to.deep.equal({ maxEntries: 0, ttlSeconds: 0.5 });
    expect(c.audit).to.deep.equal({ denials: true, runAs: false, unscoped: true, service: 'MyAudit' });
    expect(c.bus).to.deep.equal({ service: 'MyBus' });
    expect(c.principals).to.deep.equal({ anonymousEnabled: false });
    expect(c.disable).to.deep.equal([]);
  });

  it('lets a child override one key and inherit the rest', () => {
    const c = readDomainConfig(validConfig(), ['root', 'fs']);
    expect(c.domain).to.equal('fs');
    expect(c.parent).to.equal('root');
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 500, maxDelegation: 0 });
    expect(c.fields).to.deep.equal({ neverRead: ['Secret'], writeMode: 'reject' });
    expect(c.cache).to.deep.equal({ maxEntries: 0, ttlSeconds: 5 });
    expect(c.audit).to.deep.equal({ denials: false, runAs: false, unscoped: true, service: 'MyAudit' });
    expect(c.bus).to.deep.equal({ service: 'MyBus' });
    expect(c.principals).to.deep.equal({ anonymousEnabled: false });
  });

  it('lets a grandchild inherit the parent override', () => {
    const authz = { engine: { maxDelegation: 5 }, domains: { a: { engine: { modelTimeoutMs: 10 } }, b: { parent: 'a', engine: { explain: true } } } };
    const c = readDomainConfig(authz, ['root', 'a', 'b']);
    expect(c.engine).to.deep.equal({ explain: true, modelTimeoutMs: 10, maxDelegation: 5 });
    expect(c.parent).to.equal('a');
  });

  it('takes combine from the nearest level, whole', () => {
    const authz = { combine: { default: { algorithm: 'permit-overrides' }, types: { T: { algorithm: 'x' } } }, domains: { a: { combine: { default: { algorithm: 'first-applicable' } } }, b: { parent: 'a' }, c: {} } };
    expect(readDomainConfig(authz, ['root', 'a', 'b']).combine).to.deep.equal({ default: { algorithm: 'first-applicable' } });
    expect(readDomainConfig(authz, ['root', 'c']).combine.default.algorithm).to.equal('permit-overrides');
    expect(readDomainConfig(authz, ['root']).combine.types!.T.algorithm).to.equal('x');
  });

  it('reads disable and permissions for this level only', () => {
    const authz = { permissions: { 'r.p': {} }, domains: { a: { disable: ['m'], permissions: { 'a.p': { description: 'd' } } }, b: {} } };
    const a = readDomainConfig(authz, ['root', 'a']);
    expect(a.disable).to.deep.equal(['m']);
    expect(Object.keys(a.permissions)).to.deep.equal(['a.p']);
    const b = readDomainConfig(authz, ['root', 'a', 'b']);
    expect(b.disable).to.deep.equal([]);
    expect(b.permissions).to.deep.equal({});
    expect(Object.keys(readDomainConfig(authz, ['root']).permissions)).to.deep.equal(['r.p']);
  });

  it('reads domains whose name contains a dot', () => {
    expect(readDomainConfig({ domains: { 'a.b': { engine: { explain: true } } } }, ['root', 'a.b']).engine.explain).to.equal(true);
  });

  it('only merges: the schema checks the types, and a level that is not an object is skipped', () => {
    expect(readDomainConfig('x', ['root']).engine).to.deep.equal(AUTHZ_DEFAULTS.engine);
    expect(readDomainConfig({ domains: { fs: 5 } }, ['root', 'fs']).cache).to.deep.equal(AUTHZ_DEFAULTS.cache);
    expect(readDomainConfig({ engine: { modelTimeoutMs: 'x' } }, ['root']).engine.modelTimeoutMs).to.equal('x');
  });

  it('reads domains named like Object.prototype members', () => {
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const domains = JSON.parse(`{"${name}":{"engine":{"modelTimeoutMs":7}}}`);
      expect(readDomainConfig({ domains }, ['root', name]).engine.modelTimeoutMs, name).to.equal(7);
      expect(readDomainConfig({}, ['root', name]).engine.modelTimeoutMs, name).to.equal(2000);
    }
  });

  it('does not resolve a prototype-named domain absent from a non-empty domains map', () => {
    const authz = { domains: { other: { engine: { modelTimeoutMs: 7 } } } };
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const c = readDomainConfig(authz, ['root', name]);
      expect(c.engine.modelTimeoutMs, name).to.equal(2000);
      expect(c.parent, name).to.equal(undefined);
      expect(c.disable, name).to.deep.equal([]);
    }
  });

  it('ignores bus and principals set at domain level', () => {
    const authz = { domains: { fs: { bus: { service: 'X' }, principals: { anonymous: { enabled: false } } } } };
    const c = readDomainConfig(authz, ['root', 'fs']);
    expect(c.bus).to.deep.equal({});
    expect(c.principals).to.deep.equal({ anonymousEnabled: true });
  });

  it('returns a deeply frozen result', () => {
    const c = readDomainConfig(validConfig(), ['root', 'fs']);
    expect(Object.isFrozen(c)).to.equal(true);
    expect(Object.isFrozen(c.engine)).to.equal(true);
    expect(Object.isFrozen(c.fields.neverRead)).to.equal(true);
    expect(Object.isFrozen(c.combine)).to.equal(true);
    expect(Object.isFrozen(c.combine.default)).to.equal(true);
    expect(Object.isFrozen(c.permissions)).to.equal(true);
    expect(Object.isFrozen(c.permissions['fs.x'])).to.equal(true);
    expect(Object.isFrozen(c.disable)).to.equal(true);
  });

  it('does not freeze or share the configuration objects', () => {
    const authz = { fields: { neverRead: ['A'] } };
    const c = readDomainConfig(authz, ['root']);
    expect(Object.isFrozen(authz.fields.neverRead)).to.equal(false);
    expect(c.fields.neverRead).to.not.equal(authz.fields.neverRead);
  });
});
```

In `describe('legacy keys')`, replace everything from `it('does nothing without rbac', ...)` through `it('throws when rejectLegacyKeys is not a boolean', ...)` (lines 314-378 of HEAD) with the block below. The `authz.config` type cases move to the schema cases further down.

```ts
  it('does nothing without rbac', () => {
    const { warnings, log } = logger();
    checkLegacyKeys(undefined, true, log);
    expect(warnings).to.deep.equal([]);
  });

  it('warns once when rejectLegacyKeys is off', () => {
    const { warnings, log } = logger();
    checkLegacyKeys({ grants: { admin: { a: 1 } }, session: { cookie: 'c' } }, false, log);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('rbac.grants.admin.a');
    expect(warnings[0]).to.contain('authz.rbac.roles');
    expect(warnings[0]).to.contain('authn.* or users.*');
  });

  it('throws one error listing every key when rejectLegacyKeys is on', () => {
    const { warnings, log } = logger();
    let err: unknown;
    try {
      checkLegacyKeys({ grants: { admin: { a: 1 } }, session: { cookie: 'c' } }, true, log);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    const m = (err as Error).message;
    expect(m).to.contain('rbac.grants.admin.a');
    expect(m).to.contain('rbac.session.cookie');
    expect(m).to.contain('spinajs-authz-convert');
    expect(warnings).to.deep.equal([]);
  });

  it('maps rbac.user, rbac.email and rbac.actions to users.*', () => {
    const byPath = Object.fromEntries(findLegacyKeys({ user: { a: 1 }, email: 'x', actions: { b: 1 } }).map((f) => [f.path, f.to]));
    expect(byPath).to.deep.equal({ 'rbac.user.a': 'users.user', 'rbac.email': 'users.email', 'rbac.actions.b': 'users.actions' });
  });

  it('includes the notes of the rows in the text', () => {
    const { warnings, log } = logger();
    checkLegacyKeys({ defaultRole: 'x', password: { lockoutTime: 5 }, roleColumn: 'r' }, false, log);
    expect(warnings[0]).to.contain('authz.rbac.anonymousRoles');
    expect(warnings[0]).to.contain('rbac.password.lockoutTime -> removed (H31:');
    expect(warnings[0]).to.contain('authn.throttle.login.account.maxDelayMs');
    expect(warnings[0]).to.contain('rbac.roleColumn -> removed');
  });
```

In `describe('authz configuration through a child Configuration')` (Task 4.1), add after the last `it`:

```ts
  it('fills the root-level defaults of an unconfigured authz, equal to AUTHZ_DEFAULTS', async () => {
    const authz = (await booted({})).get<Record<string, unknown>>(['authz']);
    expect(authz).to.deep.include({ combine: AUTHZ_DEFAULTS.combine, engine: AUTHZ_DEFAULTS.engine, fields: AUTHZ_DEFAULTS.fields, cache: AUTHZ_DEFAULTS.cache, audit: AUTHZ_DEFAULTS.audit, principals: AUTHZ_DEFAULTS.principals, config: AUTHZ_DEFAULTS.config });
  });

  it('fills only the keys a root section leaves out', async () => {
    const authz = (await booted({ authz: { engine: { maxDelegation: 5 }, fields: { write: { mode: 'reject' } } } })).get<Record<string, unknown>>(['authz']);
    expect(authz.engine).to.deep.equal({ explain: false, modelTimeoutMs: 2000, maxDelegation: 5 });
    expect(authz.fields).to.deep.equal({ neverRead: ['Password'], write: { mode: 'reject' } });
  });

  it('puts no default inside a domain section, so the domain inherits from its parent', async () => {
    const tree = (await booted({ authz: { engine: { maxDelegation: 5 }, domains: { 'a.b': { engine: { modelTimeoutMs: 20 } }, c: { parent: 'a.b' } } } })).get<unknown>(['authz']);
    expect(configAt(tree, ['domains', 'a.b'])).to.deep.equal({ engine: { modelTimeoutMs: 20 } });
    expect(configAt(tree, ['domains', 'c'])).to.deep.equal({ parent: 'a.b' });
    expect(readDomainConfig(tree, ['root', 'a.b', 'c']).engine).to.deep.equal({ explain: false, modelTimeoutMs: 20, maxDelegation: 5 });
  });

  it('refuses a bad value at any level, naming its full path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ engine: { modelTimeoutMs: 0 } }, 'authz.engine.modelTimeoutMs'],
      [{ engine: 5 }, 'authz.engine'],
      [{ fields: { write: { mode: 'drop' } } }, 'authz.fields.write.mode'],
      [{ fields: { neverRead: 'Password' } }, 'authz.fields.neverRead'],
      [{ audit: { service: '' } }, 'authz.audit.service'],
      [{ bus: { service: '' } }, 'authz.bus.service'],
      [{ principals: { anonymous: { enabled: 'no' } } }, 'authz.principals.anonymous.enabled'],
      [{ config: 5 }, 'authz.config'],
      [{ config: { rejectLegacyKeys: 'sometimes' } }, 'authz.config.rejectLegacyKeys'],
      [{ combine: { default: {} } }, 'authz.combine.default.algorithm'],
      [{ domains: { root: {} } }, 'authz.domains.root'],
      [{ domains: { 'a.b': { engine: { explain: 'yes' } } } }, 'authz.domains.a.b.engine.explain'],
      [{ domains: { fs: { cache: { ttlSeconds: -1 } } } }, 'authz.domains.fs.cache.ttlSeconds'],
      [{ domains: { fs: { disable: 'abac' } } }, 'authz.domains.fs.disable'],
      [{ domains: { fs: { permissions: { 'fs:read': { types: 'File' } } } } }, 'authz.domains.fs.permissions.fs:read.types'],
      [{ domains: { fs: { parent: 'a b' } } }, 'authz.domains.fs.parent'],
      [{ domains: { fs: { parent: {} } } }, 'authz.domains.fs.parent'],
    ];
    for (const [authz, path] of cases) expect(await violationsOf({ authz }), path).to.include(path);
  });
```

**`packages/authz/test/host/service.test.ts`**

Change line 9 to add `DomainConfig` to the type import:

```ts
import type { AuthzChange, AuthzService, DomainConfig, ModelInitContext, ResourceRef, LruDecisionCacheOptions, DefaultAuthzDomains } from '@spinajs/authz';
```

Change line 10 to:

```ts
import { domains, installHost, instance, registerConfiguration, registerInRoot, resetHost, resetRoot, rootService, setConfig, uninstallHost, violationPaths } from './support.js';
```

In `describe('domain config')`, add before its closing `});` (line 591 of HEAD):

```ts
    it('reads the Configuration of its domain container: root keys the schema defaulted, each level over its parent', async () => {
      const d = await domains();
      const c = d.create('own-cfg');
      registerConfiguration(c, { authz: { engine: { maxDelegation: 5 }, domains: { 'own-cfg': { engine: { modelTimeoutMs: 20 }, permissions: { 'job:run': {} } } } } });
      const svc = await d.service('own-cfg');
      const cfg = (svc as unknown as { booted: { cfg: DomainConfig } }).booted.cfg;
      expect(cfg.engine).to.deep.equal({ explain: false, modelTimeoutMs: 20, maxDelegation: 5 });
      expect(cfg.cache).to.deep.equal({ maxEntries: 10000, ttlSeconds: 60 });
      expect(Object.keys(cfg.permissions)).to.deep.equal(['job:run']);
      expect((await svc.check({ principal: alice, permission: 'job:run', resource: { type: 'job', id: 'j' } })).allowed).to.equal(false);
    });

    it('a model init reads authz.<model>.* from the Configuration of its domain container', async () => {
      let seen: unknown;
      class Reading extends StaticModel {
        init(ctx: ModelInitContext): void {
          seen = [ctx.config('opts.level', 0), ctx.config('missing', 'dflt')];
        }
      }
      const d = await domains();
      const c = d.create('rdown-domain');
      registerConfiguration(c, { authz: { rdown: { opts: { level: 4 } } } });
      c.register(instance(new Reading({ name: 'rdown' }))).as(AuthorizationModel);
      await d.service('rdown-domain');
      expect(seen).to.deep.equal([4, 'dflt']);
    });

    it('fails boot with the InvalidConfiguration of its domain container, naming every full path', async () => {
      const d = await domains();
      registerConfiguration(d.create('bad-cfg'), { authz: { domains: { 'bad-cfg': { parent: 'no such/name', engine: { maxDelegation: -1 } } } } });
      expect(await violationPaths(d.service('bad-cfg'))).to.include.members(['authz.domains.bad-cfg.parent', 'authz.domains.bad-cfg.engine.maxDelegation']);
    });
```

**`packages/authz/test/host/domains.test.ts`**

Replace lines 5-6 with:

```ts
import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';

import { DefaultAuthzDomains, DefaultAuthzService, authz, AuthzConfigError, AuthzDomains, AuthzService, configuredLineage } from '@spinajs/authz';
import { domains, installHost, registerConfiguration, resetHost, resetRoot, rootDomains, rootService, setConfig, uninstallHost, violationsOf } from './support.js';
```

In `it('takes the configured parent; refuses an argument that differs from it', ...)`, delete these two lines (72-73). They tested the string check, which the schema now covers:

```ts
      setConfig(['authz', 'domains', 'k5'], { parent: 5 });
      expect(() => d.create('k5')).to.throw(AuthzConfigError, /"k5"/);
```

After that `it`, still inside `describe('create')`, add:

```ts
    it('reads authz.domains.<n>.parent through @Config from the Configuration of its container', async () => {
      const c = DI.RootContainer.child();
      try {
        registerConfiguration(c, { authz: { domains: { kid: { parent: 'mid' } } } });
        await c.resolve(Configuration);
        const d = new DefaultAuthzDomains(c);
        (d as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = c;
        d.create('mid');
        expect(d.create('kid').Parent).to.equal(d.container('mid'));
        expect(d.lineage('kid')).to.deep.equal(['root', 'mid', 'kid']);
      } finally {
        await c.dispose();
      }
    });

    it('a configured parent that is not a domain name fails the Configuration, naming the full path', async () => {
      expect(await violationsOf({ authz: { domains: { kid: { parent: 'no such/name' } } } })).to.include('authz.domains.kid.parent');
      expect(await violationsOf({ authz: { domains: { kid: { parent: {} } } } })).to.include('authz.domains.kid.parent');
    });
  });

  describe('configuredLineage', () => {
    it('follows authz.domains.<n>.parent up to root, names with dots included', () => {
      const tree = { domains: { 'a.b': { parent: 'p' }, p: {} } };
      expect(configuredLineage(tree, 'a.b')).to.deep.equal(['root', 'p', 'a.b']);
      expect(configuredLineage(tree, 'root')).to.deep.equal(['root']);
      expect(configuredLineage(undefined, 'z')).to.deep.equal(['root', 'z']);
    });

    it('refuses parents that form a cycle', () => {
      const tree = { domains: { x: { parent: 'y' }, y: { parent: 'x' }, s: { parent: 's' } } };
      expect(() => configuredLineage(tree, 'x')).to.throw(AuthzConfigError, /cycle/);
      expect(() => configuredLineage(tree, 's')).to.throw(AuthzConfigError, /cycle/);
    });
```

The original closing `});` of `describe('create')` now closes `describe('configuredLineage')`.

- [ ] **Step 3: RED**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/config.test.ts
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/domains.test.ts
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/service.test.ts
```

Expected:
- `config.test.ts`: `TSError: ⨯ Unable to compile TypeScript`, with:
  - `TS2305` ... `no exported member 'configAt'`;
  - `TS2345` (a tree is not assignable to `ConfigGetter`);
  - `TS2554: Expected 2 arguments, but got 3` (`checkLegacyKeys`).
- `domains.test.ts`: `TSError`, with `TS2305` ... `no exported member 'configuredLineage'`.
- `service.test.ts`: one failure, "fails boot with the InvalidConfiguration of its domain container, naming every full path". The message is `expected [ 'authz.domains.bad-cfg.engine.maxDelegation' ] to be a superset of [ 'authz.domains.bad-cfg.parent', …(1) ]`. The other new tests pass already: they pin that the domain container's Configuration is read.

- [ ] **Step 4: Implement**

**`packages/authz/src/host/config/defaults.ts`.** Insert above line 3 (`export const AUTHZ_DEFAULTS`):

```ts
/** The schema's root-level defaults, and the base every domain merges over (a Configuration that skips the schema starts from these). */
```

**`packages/authz/src/host/config/domain-config.ts`.** Replace the whole file. This deletes `ConfigGetter`, `Check`, the `is*` checks, `fail`, `requireObject` and the type-checking `read`.

```ts
import { DEFAULT_COMBINE } from '../../engine/routes.js';
import type { CombineConfig } from '../../engine/routes.js';
import { AUTHZ_DEFAULTS } from './defaults.js';

export interface PermissionConfig {
  readonly description?: string;
  readonly fields?: boolean;
  readonly types?: readonly string[];
  readonly implies?: readonly string[];
}

export interface DomainConfig {
  readonly domain: string;
  readonly parent?: string;
  readonly permissions: Readonly<Record<string, PermissionConfig>>;
  readonly combine: CombineConfig;
  readonly disable: readonly string[];
  readonly engine: { readonly explain: boolean; readonly modelTimeoutMs: number; readonly maxDelegation: number };
  readonly fields: { readonly neverRead: readonly string[]; readonly writeMode: 'strip' | 'reject' };
  readonly cache: { readonly maxEntries: number; readonly ttlSeconds: number };
  readonly audit: { readonly denials: boolean; readonly runAs: boolean; readonly unscoped: boolean; readonly service?: string };
  readonly bus: { readonly service?: string };
  readonly principals: { readonly anonymousEnabled: boolean };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The value at `path` in `tree`, by own properties only: a domain named 'constructor' must not resolve through the prototype. */
export function configAt(tree: unknown, path: readonly string[]): unknown {
  let cur = tree;
  for (const seg of path) {
    if (!isObject(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const k of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[k]);
  }
  return value;
}

// Copies plain data so the result never aliases the configuration objects.
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}

/**
 * The configuration of the last domain of `lineage` (root first) in the `authz` tree. The schema has checked every
 * level, so this only merges: a key comes from the nearest level that sets it, over AUTHZ_DEFAULTS.
 */
export function readDomainConfig(tree: unknown, lineage: readonly string[]): DomainConfig {
  const domain = lineage[lineage.length - 1] ?? 'root';
  const levels = [tree, ...lineage.filter((n) => n !== 'root').map((n) => configAt(tree, ['domains', n]))];
  const own = levels[levels.length - 1];

  const merged = (path: readonly string[], base: object, keys: readonly string[]): Record<string, unknown> => {
    const out = clone({ ...base }) as Record<string, unknown>;
    for (const level of levels) {
      for (const key of keys) {
        const v = configAt(level, [...path, key]);
        if (v !== undefined) out[key] = clone(v);
      }
    }
    return out;
  };

  const engine = merged(['engine'], AUTHZ_DEFAULTS.engine, ['explain', 'modelTimeoutMs', 'maxDelegation']) as unknown as DomainConfig['engine'];
  const cache = merged(['cache'], AUTHZ_DEFAULTS.cache, ['maxEntries', 'ttlSeconds']) as unknown as DomainConfig['cache'];
  const audit = merged(['audit'], AUTHZ_DEFAULTS.audit, ['denials', 'runAs', 'unscoped', 'service']) as unknown as DomainConfig['audit'];
  const fields: DomainConfig['fields'] = {
    neverRead: merged(['fields'], { neverRead: AUTHZ_DEFAULTS.fields.neverRead }, ['neverRead']).neverRead as string[],
    writeMode: merged(['fields', 'write'], AUTHZ_DEFAULTS.fields.write, ['mode']).mode as 'strip' | 'reject',
  };

  // combine is taken whole from the nearest level, never merged key by key.
  const nearest = [...levels].reverse().find((level) => configAt(level, ['combine']) !== undefined);
  const combine = nearest === undefined ? DEFAULT_COMBINE : (clone(configAt(nearest, ['combine'])) as CombineConfig);

  const busService = configAt(tree, ['bus', 'service']) as string | undefined;
  const anonymous = configAt(tree, ['principals', 'anonymous', 'enabled']) as boolean | undefined;
  const parent = levels.length > 1 ? (configAt(own, ['parent']) as string | undefined) : undefined;

  const result: DomainConfig = {
    domain,
    ...(parent !== undefined ? { parent } : {}),
    permissions: clone((configAt(own, ['permissions']) ?? {}) as Record<string, PermissionConfig>),
    combine,
    disable: clone((configAt(own, ['disable']) ?? []) as string[]),
    engine,
    fields,
    cache,
    audit,
    bus: busService === undefined ? {} : { service: busService },
    principals: { anonymousEnabled: anonymous ?? AUTHZ_DEFAULTS.principals.anonymous.enabled },
  };
  return deepFreeze(result);
}
```

**`packages/authz/src/host/config/legacy-keys.ts`.** Replace lines 68-81 (`checkLegacyKeys`) with the version below. It deletes the `authz.config` object check and the `rejectLegacyKeys` boolean check.

```ts
export function checkLegacyKeys(rbac: unknown, reject: boolean, log: Pick<EngineLog, 'warn'>): void {
  if (rbac === undefined || rbac === null) return;

  const lines = findLegacyKeys(rbac).map((f) => `${f.path} -> ${f.to ?? 'removed'}${f.note && f.note !== 'removed' ? ` (${f.note})` : ''}`);
  const text = `Authz 3.x does not read the 2.x "rbac" configuration. Move these keys (the spinajs-authz-convert tool rewrites them): ${lines.join('; ')}`;

  if (reject) throw new AuthzConfigError(text);
  log.warn(text);
}
```

**`packages/authz/src/host/service.ts`**

- Line 3 becomes:

```ts
import { Config, Configuration } from '@spinajs/configuration';
```

- Lines 25-27 become:

```ts
import { checkLegacyKeys } from './config/legacy-keys.js';
import { AUTHZ_DEFAULTS } from './config/defaults.js';
import { configAt, readDomainConfig } from './config/domain-config.js';
import type { DomainConfig } from './config/domain-config.js';
```

- After line 111 (`private readonly log: EngineLog = engineLog('authz');`), insert:

```ts

  /** The whole authz tree: domain names may contain dots, so a domain's section is indexed (configAt), never read by a dotted path. */
  @Config('authz')
  protected Config: unknown;

  @Config('authz.config.rejectLegacyKeys', { defaultValue: AUTHZ_DEFAULTS.config.rejectLegacyKeys })
  protected RejectLegacyKeys: boolean;

  /** The 2.x section, read only to report its keys. */
  @Config('rbac')
  protected LegacyRbac: unknown;
```

- Replace lines 323-328, which are:

```ts
    const configuration = (await container.resolve(Configuration)) as unknown as Configuration;
    if (!isObject(configuration) || typeof configuration.get !== 'function') throw new AuthzConfigError(`${where}: the resolved Configuration has no get()`);
    const get = (path: string[]): unknown => configuration.get(path);
    const lineage = domains.lineage(name);
    if (parent === undefined) checkLegacyKeys(get, this.log);
    const cfg = readDomainConfig(get, lineage);
```

  with:

```ts
    // @Config reads only a resolved Configuration, and a domain container may register its own.
    await container.resolve(Configuration);
    const lineage = domains.lineage(name);
    if (parent === undefined) checkLegacyKeys(this.LegacyRbac, this.RejectLegacyKeys, this.log);
    const cfg = readDomainConfig(this.Config, lineage);
```

- Line 404 becomes:

```ts
      const record = await this.initModel(where, name, model, registry, register, fresh);
```

- Line 515 (the `initModel` signature) becomes:

```ts
  private async initModel(where: string, domain: string, model: AuthorizationModel, registry: PermissionRegistryImpl, register: (defs: readonly PermissionInput[], source: string) => readonly PermissionInput[], fresh: AuthorizationModel[]): Promise<ModelInit> {
```

- Line 543 (`config: <T>(path: string, dflt?: T): T => configuration.get<T>(['authz', model.name, ...String(path).split('.')], dflt as T),`) becomes:

```ts
      config: <T>(path: string, dflt?: T): T => {
        const v = configAt(this.Config, [model.name, ...String(path).split('.')]);
        return (v === undefined ? dflt : v) as T;
      },
```

**`packages/authz/src/host/domains.ts`**

- Lines 1-3 become:

```ts
import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
```

- After line 7 (`import { engineLog } from './log.js';`), insert:

```ts
import { configAt } from './config/domain-config.js';
```

- Replace line 36 (`const isRecord = ...`) with:

```ts
/** The parent `authz.domains.<name>.parent` names in the authz tree. */
export function configuredParent(tree: unknown, name: string): string | undefined {
  return configAt(tree, ['domains', name, 'parent']) as string | undefined;
}

/** Domain names from 'root' to `name` by the configured parents: the lineage before the host has created its domains. */
export function configuredLineage(tree: unknown, name: string): readonly string[] {
  const out = [name];
  for (let d = name; d !== ROOT; ) {
    const parent = configuredParent(tree, d) ?? ROOT;
    // The schema checks each entry on its own; only the chain across entries can loop.
    if (out.includes(parent)) throw new AuthzConfigError(`The configured parents of authz domain ${q(name)} form a cycle`);
    out.unshift(parent);
    d = parent;
  }
  return Object.freeze(out);
}
```

- After line 44 (`private readonly entered = new WeakSet<AuthzService>();`), insert:

```ts

  /** Read synchronously by create(): the root Configuration must be resolved before the first create(). */
  @Config('authz')
  protected Config: unknown;
```

- Line 57 becomes:

```ts
    const configured = configuredParent(this.Config, name);
```

- Delete lines 168-182: the private `configuredParent` method with its `rootContainer.get(Configuration)` read and its string check. `rootContainer` stays, because the constructor and `create()` use it.

**`packages/authz/src/admin/admin.ts`.** Line 390 becomes the line below. Task 4.3 replaces the rest of `env()`.

```ts
    const domainCfg = readDomainConfig(get(['authz']), domains.lineage(domain));
```

**`packages/authz-http/src/access/policy.ts`.** Line 151 becomes:

```ts
    if (!readDomainConfig(configuration?.get(['authz']), domains.lineage(domain)).engine.explain) return undefined;
```

**`packages/authz-http/src/domains.ts`.** Line 37 becomes:

```ts
  const cfg = readDomainConfig(configuration?.get(['authz']), domains.lineage(domain));
```

**`packages/authz-http/src/fields.ts`.** Line 35 becomes:

```ts
    const cfg = readDomainConfig(configuration?.get(['authz']), domains.lineage(domain));
```

**`packages/authz-orm/src/principal.ts`.** Replace lines 1-27, the imports through `domainConfig`. This deletes `lineageOf` with its string and cycle checks, and the `typeof configuration.get` guard.

```ts
import { AuthzDomains, DefaultAuthzDomains, configuredLineage, readDomainConfig, resolveDelegation } from '@spinajs/authz';
import type { AuthzService, DomainConfig, Principal } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

const ROOT = 'root';

/** The domain's config over its lineage: the host's lineage once it has created its domains, else the configured parents. */
function domainConfig(domain: string): DomainConfig {
  const tree = DI.get(Configuration)?.get<unknown>(['authz']);
  const domains: unknown = DI.get(AuthzDomains);
  const lineage = domains instanceof DefaultAuthzDomains ? domains.lineage(domain) : configuredLineage(tree, domain);
  return readDomainConfig(tree, lineage);
}
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/config.test.ts test/host/domains.test.ts test/host/service.test.ts
npm test
cd ../authz-orm && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test
cd ../authz-abac && npm test
cd ../authz-rbac && npm test
cd ../authz-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../users && npm test
```

Expected: everything passes, beyond the baseline. Watch authz-orm `relations.test.ts`, "a child domain reads its own engine section over its lineage's": it now runs through `configuredLineage`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host packages/authz/src/admin/admin.ts packages/authz/test/host packages/authz-http/src/access/policy.ts packages/authz-http/src/domains.ts packages/authz-http/src/fields.ts packages/authz-orm/src/principal.ts
git commit -m "refactor(authz): the domain tree through @Config and the schema; readDomainConfig only merges" -m "Root-level defaults move into AUTHZ_CONFIGURATION_SCHEMA; authz.domains.<n> keeps none, so a domain still inherits every unset key. A bad value now fails the Configuration boot with InvalidConfiguration; a configured parent must be a domain name."
```

---

### Task 4.3: `DefaultAuthzAdmin` and `assertAdminPermission` take `authz.admin` from `@Config` and the schema (row 3)

**Files:**
- Modify: `packages/authz/src/host/config/schema.ts`:
  - an import after line 1;
  - constants after the `audit` builder;
  - `admin` after `bus` in the root `properties`.
- Modify: `packages/authz/src/admin/config.ts:1-72`. Delete `readAdminConfig` and its helpers. Keep the types, `ADMIN_DEFAULTS` and `mapPermission`.
- Modify: `packages/authz/src/admin/admin.ts`: line 3, lines 19-20, after line 100, and `env()` (368-395 of HEAD).
- Modify: `packages/authz/src/admin/permit.ts:1-35` (the whole file)
- Test: `packages/authz/test/host/config.test.ts` (`validConfig`, a new `describe`), `packages/authz/test/admin/execute.test.ts`

**Interfaces:**
- Consumes: the Task 4.1 helpers, and `readDomainConfig(tree, lineage)` from 4.2.
- Produces:
  - the `authz.admin` schema block;
  - `DefaultAuthzAdmin.Config`, `MaxBatch`, `Backend`, `GuardService` and `Permissions` (`@Config`).
- Phase 5 consumes `authz.admin.guard` (`readGuardConfig`) and `authz.admin.connection`.
- Removes: `readAdminConfig`.

- [ ] **Step 1: Schema additions**

In `schema.ts`, after line 1 (`import { AUTHZ_DEFAULTS } from './defaults.js';`), insert:

```ts
import { ADMIN_DEFAULTS } from '../../admin/config.js';
```

After the `audit` builder (`const audit = (root: boolean) => ({ ... });`), insert:

```ts

/** A permission name as contracts/permission.ts accepts it. */
const permissionName = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z][A-Za-z0-9_.-]*$' };

const className = { type: 'string', minLength: 1 };

const admin = {
  type: 'object',
  default: {},
  properties: {
    maxBatch: { type: 'integer', minimum: 1, default: ADMIN_DEFAULTS.maxBatch },
    backend: { ...className, default: ADMIN_DEFAULTS.backend },
    connection: { type: 'string', minLength: 1 },
    // { [kind or 'family.*']: permission | { [scopeType or '*']: permission } }
    permissions: {
      type: 'object',
      default: {},
      additionalProperties: { anyOf: [permissionName, { type: 'object', additionalProperties: permissionName }] },
    },
    guard: {
      type: 'object',
      properties: {
        service: className,
        privilegedPermission: permissionName,
        protectSystemRole: { type: 'boolean', default: true },
        preventEscalation: { type: 'boolean', default: true },
        preventSelfLockout: { type: 'boolean', default: true },
        preventLastPrivilegedRemoval: { type: 'boolean', default: true },
      },
      // The self-lockout and last-holder checks need privilegedPermission unless both are off; an unset switch is on.
      if: { not: { properties: { preventSelfLockout: { const: false }, preventLastPrivilegedRemoval: { const: false } }, required: ['preventSelfLockout', 'preventLastPrivilegedRemoval'] } },
      then: { required: ['privilegedPermission'] },
    },
  },
};
```

In the root `properties`, after the `bus: { ... },` line, insert:

```ts
    admin,
```

- [ ] **Step 2: Failing tests**

**`packages/authz/test/host/config.test.ts`**

Add `ADMIN_DEFAULTS` to the `@spinajs/authz` import (line 7).

In `validConfig()`, add after `config: { rejectLegacyKeys: true },`. Every admin default is present, so "accepts a valid config unchanged" stays a test of no change.

```ts
  admin: {
    maxBatch: 50,
    backend: 'DbAuthzAdminBackend',
    connection: 'authz',
    permissions: { 'assignment.*': 'app:members.manage', 'assignment.grant': { project: 'app:project.share', '*': 'app:any.share' } },
    guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: false },
  },
```

Insert before `describe('AuthzConfigBootstrapper', () => {`:

```ts
describe('authz.admin through a child Configuration', function () {
  this.timeout(30000);
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function admin(values: Record<string, unknown>): Promise<unknown> {
    const { child, configuration } = await childWith(values);
    children.push(child);
    return configuration.get(['authz', 'admin']);
  }

  it('fills maxBatch, backend and permissions from ADMIN_DEFAULTS, and no guard', async () => {
    expect(await admin({})).to.deep.equal({ ...ADMIN_DEFAULTS, permissions: {} });
  });

  it('turns every switch of a configured guard on', async () => {
    expect(await admin({ authz: { admin: { guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update' } } } })).to.deep.equal({
      ...ADMIN_DEFAULTS,
      permissions: {},
      guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
    });
  });

  it('needs privilegedPermission while a self-lockout or last-holder check is on', async () => {
    expect(await violationsOf({ authz: { admin: { guard: { service: 'X' } } } })).to.include('authz.admin.guard.privilegedPermission');
    expect(await violationsOf({ authz: { admin: { guard: { preventSelfLockout: false } } } })).to.include('authz.admin.guard.privilegedPermission');
    expect(await admin({ authz: { admin: { guard: { service: 'X', preventSelfLockout: false, preventLastPrivilegedRemoval: false } } } })).to.have.nested.property('guard.service', 'X');
  });

  it('refuses a bad value, naming its full path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ maxBatch: 0 }, 'authz.admin.maxBatch'],
      [{ maxBatch: 1.5 }, 'authz.admin.maxBatch'],
      [{ backend: '' }, 'authz.admin.backend'],
      [{ connection: '' }, 'authz.admin.connection'],
      [{ guard: { service: '', privilegedPermission: 'users:update' } }, 'authz.admin.guard.service'],
      [{ guard: { privilegedPermission: 'users' } }, 'authz.admin.guard.privilegedPermission'],
      [{ guard: { protectSystemRole: 'sometimes', privilegedPermission: 'users:update' } }, 'authz.admin.guard.protectSystemRole'],
      [{ permissions: 'x' }, 'authz.admin.permissions'],
      [{ permissions: { 'assignment.grant': 42 } }, 'authz.admin.permissions.assignment.grant'],
      [{ permissions: { 'assignment.grant': { project: 'not a permission' } } }, 'authz.admin.permissions.assignment.grant'],
    ];
    for (const [value, path] of cases) expect(await violationsOf({ authz: { admin: value } }), path).to.include(path);
  });
});
```

**`packages/authz/test/admin/execute.test.ts`**

Imports. After line 3 (`import { userPrincipal } from '@spinajs/authz-testing';`), insert:

```ts
import { Configuration } from '@spinajs/configuration';
```

Line 7 becomes:

```ts
import { FailingBus, HOUR, PERMISSIONS, START, ThrowingAudit, ThrowingSink, adminConfig, adminDomain, installHost, rejection, resetHost, uninstallHost } from './support.js';
import { registerConfiguration, violationPaths } from '../host/support.js';
```

Delete `it('rejects a malformed mapping with an AuthzConfigError naming the key', ...)` (lines 376-382 of HEAD). The schema case `authz.admin.permissions.assignment.grant` replaces it.

After the closing `});` of `describe('authz.admin.permissions')` (line 383 of HEAD), insert:

```ts

  describe('authz.admin from the Configuration of the domain container', () => {
    const own = (admin: Record<string, unknown>) => ({
      authz: {
        admin: { guard: { service: 'FakeGuard', privilegedPermission: 'app:settings.manage' }, backend: 'TestBackend', ...admin },
        domains: { test: { permissions: PERMISSIONS, cache: { maxEntries: 0 } } },
      },
    });

    it('takes maxBatch from it over the root value', async () => {
      adminConfig({ maxBatch: 50 });
      const d = await adminDomain('test', { register: (c) => registerConfiguration(c, own({ maxBatch: 2 })) });
      const err = await rejection(d.admin.execute(alice, [grant('a'), grant('b'), grant('c')]));
      expect((err as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect(await d.admin.execute(alice, [grant('a'), grant('b')])).to.have.length(2);
    });

    it('gets maxBatch 100 from the schema when it sets none', async () => {
      adminConfig({ maxBatch: 2 });
      const d = await adminDomain('test', { register: (c) => registerConfiguration(c, own({})) });
      expect(d.container.get(Configuration).get('authz.admin.maxBatch')).to.equal(100);
      const many = Array.from({ length: 101 }, (_, i) => grant(`u${i}`));
      expect(((await rejection(d.admin.execute(alice, many))) as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect(await d.admin.execute(alice, many.slice(1))).to.have.length(100);
    });

    it('fails the domain boot on a bad authz.admin value, naming the full path', async () => {
      const err = await rejection(adminDomain('test', { register: (c) => registerConfiguration(c, own({ maxBatch: 0 })) }));
      expect(await violationPaths(Promise.reject(err))).to.include('authz.admin.maxBatch');
    });
  });
```

- [ ] **Step 3: RED**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/config.test.ts
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/admin/execute.test.ts
```

Expected:
- `config.test.ts`: the four `authz.admin through a child Configuration` tests fail:
  - the defaults: `expected undefined to deeply equal { maxBatch: 100, … }`;
  - the guard: `the configuration is refused (got undefined): expected undefined to be an instance of InvalidConfiguration`.
- `execute.test.ts`: two failures:
  - "gets maxBatch 100 from the schema": `expected undefined to equal 100`;
  - "fails the domain boot": `expected a rejection`.
  - "takes maxBatch from it over the root value" passes already. It pins the container.

- [ ] **Step 4: Implement**

**`packages/authz/src/admin/config.ts`.** Replace the whole file. This deletes `readAdminConfig`, `isObject`, `q`, and the `AuthzConfigError` and `isPermission` imports.

```ts
import type { Permission } from '../contracts/permission.js';
import type { ResourceType } from '../contracts/principal.js';

/** `{ [kind or 'family.*']: permission | { [scopeType or '*']: permission } }` */
export type AdminPermissionMap = Readonly<Record<string, Permission | Readonly<Record<string, Permission>>>>;

export interface AdminConfig {
  readonly maxBatch: number;
  readonly permissions: AdminPermissionMap;
  /** The AuthzAdminBackend class name. */
  readonly backend: string;
  /** The AdminGuard class name; undefined fails every call closed. */
  readonly guard?: string;
}

/** The schema defaults of authz.admin; DefaultAuthzAdmin falls back to them for a Configuration that skips the schema. */
export const ADMIN_DEFAULTS = Object.freeze({ maxBatch: 100, backend: 'MemoryAuthzAdminBackend' });

/**
 * The permission authz.admin.permissions maps `kind` at `type` to, else `fallback`.
 * Exact kind before its family ('assignment.*'); within an entry, the scope type before '*'.
 * An entry without a match for the type passes on to the next one.
 */
export function mapPermission(map: AdminPermissionMap, kind: string, type: ResourceType, fallback: Permission): Permission {
  const dot = kind.indexOf('.');
  const keys = dot > 0 ? [kind, `${kind.slice(0, dot)}.*`] : [kind];
  for (const key of keys) {
    if (!Object.hasOwn(map, key)) continue;
    const value = map[key];
    if (typeof value === 'string') return value;
    if (Object.hasOwn(value, type)) return value[type];
    if (Object.hasOwn(value, '*')) return value['*'];
  }
  return fallback;
}
```

**`packages/authz/src/admin/admin.ts`**

- Line 3 becomes:

```ts
import { Config } from '@spinajs/configuration';
```

- Lines 19-20 become:

```ts
import { ADMIN_DEFAULTS, mapPermission } from './config.js';
import type { AdminConfig, AdminPermissionMap } from './config.js';
```

- After line 100 (`private readonly log = engineLog('authz-admin');`), insert:

```ts

  /** The authz tree, for the bus and audit the domain's lineage configures. */
  @Config('authz')
  protected Config: unknown;

  @Config('authz.admin.maxBatch', { defaultValue: ADMIN_DEFAULTS.maxBatch })
  protected MaxBatch: number;

  @Config('authz.admin.backend', { defaultValue: ADMIN_DEFAULTS.backend })
  protected Backend: string;

  @Config('authz.admin.guard.service')
  protected GuardService: string | undefined;

  @Config('authz.admin.permissions', { defaultValue: {} })
  protected Permissions: AdminPermissionMap;
```

- Replace the whole `private async env(): Promise<Env> { ... }` method with the version below. It deletes the `Configuration` resolve, the `has no get()` check, the `get` helper and the `readAdminConfig` call.

```ts
  private async env(): Promise<Env> {
    const c = this.container;
    if (!isObject(c) || typeof c.resolve !== 'function') throw new AuthzConfigError('DefaultAuthzAdmin needs the container it is resolved in');
    const service = (await c.resolve(AuthzService)) as AuthzService;
    const domain = service.domain;
    const where = `Authz domain ${q(domain)}`;
    const cfg: AdminConfig = Object.freeze({ maxBatch: this.MaxBatch, backend: this.Backend, permissions: this.Permissions, ...(this.GuardService === undefined ? {} : { guard: this.GuardService }) });

    if (cfg.guard === undefined) throw new AuthzConfigError(`${where}: authz.admin.guard.service is not set; AuthzAdmin refuses every call until it names a registered AdminGuard class`);
    const guard = await this.named(AdminGuard, cfg.guard, 'authz.admin.guard.service', where);
    if (!isObject(guard) || typeof guard.check !== 'function') throw new AuthzConfigError(`${where}: authz.admin.guard.service resolved to ${q(guard)}, which has no check()`);
    const backend = await this.named(AuthzAdminBackend, cfg.backend, 'authz.admin.backend', where);
    if (!isObject(backend) || typeof backend.transaction !== 'function') throw new AuthzConfigError(`${where}: authz.admin.backend resolved to ${q(backend)}, which has no transaction()`);
    const clock = (await c.resolve(AuthzClock)) as AuthzClock;
    if (!isObject(clock) || typeof clock.now !== 'function') throw new AuthzConfigError(`${where}: the resolved AuthzClock has no now()`);

    // The bus and audit the domain's AuthzService picked at boot, chosen the same way.
    const domains: unknown = await c.resolve(AuthzDomains);
    if (!(domains instanceof DefaultAuthzDomains)) throw new AuthzConfigError(`${where}: AuthzAdmin needs DefaultAuthzDomains as the AuthzDomains singleton`);
    const domainCfg = readDomainConfig(this.Config, domains.lineage(domain));
    const bus = await this.pick(ChangeBus, domainCfg.bus.service, 'authz.bus.service', where);
    const audit = await this.pick(DecisionAudit, domainCfg.audit.service, 'authz.audit.service', where);

    return { where, domain, service, cfg, guard, backend, clock, bus, audit };
  }
```

The `c.resolve(AuthzService)` above boots the domain service first, and that boot resolves the domain container's Configuration. So the `@Config` reads here always find a resolved Configuration.

**`packages/authz/src/admin/permit.ts`.** Replace the whole file. `@Config` cannot apply here: this is a free function, and its container comes from the call context.

```ts
import { Configuration } from '@spinajs/configuration';

import { AuthzAdminFailure } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand } from '../contracts/admin.js';
import type { Permission } from '../contracts/permission.js';
import { principalKey } from '../contracts/principal.js';
import type { Principal, ResourceRef } from '../contracts/principal.js';
import { resourceKey } from '../contracts/resource.js';
import type { AuthzService } from '../contracts/service.js';
import { mapPermission } from './config.js';
import type { AdminPermissionMap } from './config.js';
import { adminActor, adminContainer } from './context.js';

/** Allowed and unconditional, else AuthzAdminFailure('forbidden'): a command or a read has no row to evaluate a residual against. */
export async function requirePermitted(authz: AuthzService, actor: Principal, permission: Permission, resource: ResourceRef): Promise<void> {
  const d = await authz.check({ principal: actor, permission, resource });
  if (!d.allowed || d.residual?.op !== 'true') {
    const why = d.allowed ? 'only conditionally' : d.reason?.code ?? 'denied';
    throw new AuthzAdminFailure('forbidden', `${principalKey(actor)} may not ${permission} on ${resourceKey(resource)} (${why})`);
  }
}

/**
 * Checks the permission of `kind` at a second resource, exactly as AuthzAdmin checks the one its handler's
 * `permission()` names (mapped by authz.admin.permissions, else `fallback`). For a handler whose command also
 * reaches a resource other than that one, such as a row moved out of its old scope.
 */
export async function assertAdminPermission(ctx: AdminContext, kind: AuthzCommand['kind'], resource: ResourceRef, fallback: Permission): Promise<void> {
  const actor = adminActor(ctx);
  // A free function gets no @Config: it reads the section the schema validated from the domain container's Configuration.
  const configuration = (await adminContainer(ctx).resolve(Configuration)) as Configuration;
  const permissions = configuration.get<AdminPermissionMap>(['authz', 'admin', 'permissions'], {});
  await requirePermitted(ctx.authz, actor, mapPermission(permissions, kind, resource.type, fallback), resource);
}
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/config.test.ts
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/admin/execute.test.ts test/admin/permit.test.ts test/admin/domains.test.ts test/admin/sugar-list.test.ts
npm test
cd ../authz-orm && npm test
cd ../authz-abac && npm test
cd ../authz-rbac && npm test
cd ../authz-http && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../users && npm test
```

Expected: everything passes, beyond the baseline.
- authz-rbac's admin tests run `assertAdminPermission` and `DefaultAuthzAdmin` against the root `TestConfiguration`, so the `@Config` default values must cover them.
- The users shipped config (`authz-rbac/src/config/admin.ts`) names `privilegedPermission`, so the new guard rule accepts it.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host/config/schema.ts packages/authz/src/admin/config.ts packages/authz/src/admin/admin.ts packages/authz/src/admin/permit.ts packages/authz/test/host/config.test.ts packages/authz/test/admin/execute.test.ts
git commit -m "refactor(authz): authz.admin through @Config and the schema, no readAdminConfig" -m "New authz.admin schema block (maxBatch, backend, connection, permissions, guard). A configured guard with a self-lockout or last-holder switch on now needs privilegedPermission at boot instead of at the first guard call."
```

---

### Task 4.4: `ConfigScopeAttributeSchemas` takes `authz.scopes.attributes` from `@Config` and the schema (row 4)

**Files:**
- Modify: `packages/authz/src/host/config/schema.ts`: `const scopes` after `const permissions`, and `scopes` after `principals` in the root `properties`.
- Modify: `packages/authz/src/admin/scope-attributes/schemas.ts:1-56`
- Test: `packages/authz/test/admin/scope-attributes.test.ts`:
  - imports at lines 1-7;
  - `describe('ConfigScopeAttributeSchemas')` at 221-268, where the test at 249-261 is replaced.

**Interfaces:**
- Consumes: the Task 4.1 helpers, `CONFIGURATION_CONTAINER_KEY`, and the schema file layout from 4.2.
- Produces:
  - the `authz.scopes.attributes` schema block;
  - `ConfigScopeAttributeSchemas.Attributes` (`@Config('authz.scopes.attributes')`).
- Removes: the shape checks of `contribute()`, `CONFIG_KEY`, and the `DI.resolve(Configuration)` read.

- [ ] **Step 1: Schema additions**

In `schema.ts`, after `const permissions = { ... };`, insert:

```ts

// null turns off a section a shipped config sets (config merges never remove a key).
const scopes = {
  type: 'object',
  properties: {
    attributes: {
      type: ['object', 'null'],
      propertyNames: { minLength: 1 },
      additionalProperties: {
        type: 'object',
        properties: {
          schema: { type: 'object' },
          defaults: { type: 'object', default: {} },
        },
        required: ['schema'],
      },
    },
  },
};
```

In the root `properties`, after the closing `},` of `principals: { ... }`, insert:

```ts
    scopes,
```

- [ ] **Step 2: Failing tests**

In `packages/authz/test/admin/scope-attributes.test.ts`, after line 3 (`import { userPrincipal } from '@spinajs/authz-testing';`), insert:

```ts
import type { IContainer } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';
```

After line 7 (`import type { AdminDomain } from './support.js';`), insert:

```ts
import { childWith, violationsOf } from '../host/support.js';
```

In `describe('ConfigScopeAttributeSchemas')`, after the `beforeEach(async () => { await resetHost(); });` block, insert:

```ts

  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function contributorOn(values: Record<string, unknown>): Promise<ConfigScopeAttributeSchemas> {
    const { child } = await childWith(values);
    children.push(child);
    const contributor = new ConfigScopeAttributeSchemas();
    (contributor as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;
    return contributor;
  }
```

Replace `it('refuses a malformed section, naming the key', ...)` (lines 249-261 of HEAD) with:

```ts
  it('reads authz.scopes.attributes from the Configuration of the container that built it, with the schema default for defaults', async () => {
    const schema = { type: 'object' };
    const contributor = await contributorOn({ authz: { scopes: { attributes: { org: { schema } } } } });
    expect((await contributor.contribute('any')).scopeAttributeSchemas).to.deep.equal([{ scopeType: 'org', schema, defaults: {} }]);
  });

  it('a null section contributes nothing', async () => {
    expect(await (await contributorOn({ authz: { scopes: { attributes: null } } })).contribute('any')).to.deep.equal({});
  });

  it('refuses a malformed section at boot, naming the full path', async () => {
    const cases: [unknown, string][] = [
      ['x', 'authz.scopes.attributes'],
      [{ org: 1 }, 'authz.scopes.attributes.org'],
      [{ org: { defaults: {} } }, 'authz.scopes.attributes.org.schema'],
      [{ org: { schema: {}, defaults: [] } }, 'authz.scopes.attributes.org.defaults'],
      [{ '': { schema: {} } }, 'authz.scopes.attributes.'],
    ];
    for (const [attributes, path] of cases) expect(await violationsOf({ authz: { scopes: { attributes } } }), path).to.include(path);
  });
```

- [ ] **Step 3: RED**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/admin/scope-attributes.test.ts
```

Expected: two failures.
- "reads authz.scopes.attributes from the Configuration of the container that built it ...": `expected undefined to deeply equal [ { scopeType: 'org', … } ]`. The current code reads the root Configuration through `DI.resolve`.
- "refuses a malformed section at boot ...": `the configuration is refused (got undefined): expected undefined to be an instance of InvalidConfiguration`.

"a null section contributes nothing" passes already.

- [ ] **Step 4: Implement**

In `packages/authz/src/admin/scope-attributes/schemas.ts`:

- Lines 1-3 become:

```ts
import { Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
```

- Delete line 13 (`const CONFIG_KEY = 'authz.scopes.attributes';`).
- Replace the class (lines 34-56, from `@Singleton()` through the closing `}` of the class) with the version below. It deletes the `DI.resolve(Configuration)` read, `fail` and the four shape checks. The doc comment above the class (lines 26-33) stays.

```ts
@Singleton()
@Injectable(AuthzContributor)
export class ConfigScopeAttributeSchemas extends AuthzContributor {
  @Config('authz.scopes.attributes')
  protected Attributes: Readonly<Record<string, { readonly schema: object; readonly defaults?: Readonly<Record<string, unknown>> }>> | null | undefined;

  async contribute(_domain: string): Promise<AuthzContribution> {
    const section = this.Attributes;
    if (section === undefined || section === null) return {};
    // defaults is a schema default; a Configuration that skips the schema can leave it out.
    return { scopeAttributeSchemas: Object.entries(section).map(([scopeType, { schema, defaults = {} }]) => ({ scopeType, schema, defaults })) };
  }
}
```

`isPlainObject`, `q`, `describeError` and `AuthzConfigError` stay: `contributedSchemas` and `schemaValidator` use them. Those keep their checks, because they cover contributions from any `AuthzContributor` (runtime data, not configuration) and the compile of each schema.

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/admin/scope-attributes.test.ts test/admin/scope-attributes-behaviour.test.ts
npm test
cd ../authz-orm && npm test
cd ../authz-abac && npm test
cd ../authz-rbac && npm test
cd ../authz-http && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../users && npm test
```

Expected: everything passes, beyond the baseline. `users/test/support/users-db.ts` registers `ConfigScopeAttributeSchemas` by name; the class name is unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host/config/schema.ts packages/authz/src/admin/scope-attributes/schemas.ts packages/authz/test/admin/scope-attributes.test.ts
git commit -m "refactor(authz): authz.scopes.attributes through @Config and the schema"
```

---

### Task 4.5: `isProduction` takes the caller's `@Config` flag (row 5)

**Files:**
- Modify: `packages/authz/src/host/env.ts:1-15` (the whole file)
- Modify: `packages/authz-http/src/access/policy.ts`: line 2, after line 50, and line 146
- Modify: `packages/authz-http/src/explain/source.ts`: lines 1-2, after line 17, and line 21
- Test: `packages/authz/test/host/defaults.test.ts`: line 4, and `describe('isProduction')` at 225-303

**Interfaces:**
- Consumes: `@Config('configuration.isProduction')`.
- Produces: `isProduction(flag: boolean | undefined): boolean`.
- Removes: the `DI.has` / `DI.get(Configuration)` read, the `typeof` check and the `try/catch` of `isProduction`.

What stays in code: the environment fallback for an unset flag. A schema cannot read `APP_ENV`. A CJS app or a test Configuration may not load the shipped `configuration` module, and an explain trace must not leak in production.

There is no child Configuration here. `ExplainControllerSource` is a root `ControllerSource`, and http resolves `AccessPolicy` from root. Both read the root Configuration. authz-http's `explain.test.ts` (`configuration.isProduction` true/false) and `access-policy.test.ts` (`explain(on, production)`) already drive both callers through the root `TestConfiguration`, and they stay as the regression net.

- [ ] **Step 1: Schema additions**

None. `configuration.*` belongs to `@spinajs/configuration`, which has no schema. Out of scope.

- [ ] **Step 2: Failing tests**

In `packages/authz/test/host/defaults.test.ts`, delete line 4 (`import { Configuration } from '@spinajs/configuration';`); only the deleted block used it. Then replace `describe('isProduction', () => { ... });` (lines 225-303) with:

```ts
describe('isProduction', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the configured flag wins over the environment', () => {
    process.env.APP_ENV = 'prod';
    expect(isProduction(false)).to.equal(false);
    process.env.APP_ENV = 'dev';
    expect(isProduction(true)).to.equal(true);
  });

  it('without a flag follows APP_ENV, then NODE_ENV', () => {
    process.env.APP_ENV = 'prod';
    expect(isProduction(undefined)).to.equal(true);
    process.env.APP_ENV = 'development';
    process.env.NODE_ENV = 'production';
    expect(isProduction(undefined)).to.equal(false);
    delete process.env.APP_ENV;
    expect(isProduction(undefined)).to.equal(true);
    process.env.NODE_ENV = 'dev';
    expect(isProduction(undefined)).to.equal(false);
    delete process.env.NODE_ENV;
    expect(isProduction(undefined)).to.equal(false);
  });
});
```

- [ ] **Step 3: RED**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/defaults.test.ts
```

Expected: `TSError: ⨯ Unable to compile TypeScript`, with `TS2554: Expected 0 arguments, but got 1` on each `isProduction(...)` call.

- [ ] **Step 4: Implement**

Replace `packages/authz/src/host/env.ts` with:

```ts
import { normalizeEnvironment } from '@spinajs/configuration';

/**
 * `flag` is the caller's @Config('configuration.isProduction'). Without it (a Configuration that does not load the
 * shipped configuration module, such as a test one) the environment decides, which a schema cannot read.
 */
export function isProduction(flag: boolean | undefined): boolean {
  return flag ?? normalizeEnvironment(process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development') === 'prod';
}
```

**`packages/authz-http/src/access/policy.ts`**

- Line 2 becomes:

```ts
import { Config, Configuration } from '@spinajs/configuration';
```

- After line 50 (`export class AccessPolicy extends BasePolicy {`), insert:

```ts
  @Config('configuration.isProduction')
  protected IsProduction: boolean | undefined;

```

- Line 146 (`if (isProduction()) return undefined;`) becomes:

```ts
    if (isProduction(this.IsProduction)) return undefined;
```

**`packages/authz-http/src/explain/source.ts`**

- Lines 1-2 become:

```ts
import { ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { isProduction } from '@spinajs/authz';
```

- After line 17 (`protected Log: Log;`), insert:

```ts

  @Config('configuration.isProduction')
  protected IsProduction: boolean | undefined;
```

- Line 21 (`if (isProduction()) {`) becomes:

```ts
    if (isProduction(this.IsProduction)) {
```

- [ ] **Step 5: GREEN + package suite + dependants**

```bash
cd packages/authz
npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json
npx ts-mocha -p tsconfig.json --no-config -n experimental-specifier-resolution=node -n loader=ts-node/esm --timeout 30000 test/host/defaults.test.ts
npm test
cd ../authz-orm && npm test
cd ../authz-abac && npm test
cd ../authz-rbac && npm test
cd ../authz-http && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json && npm test
cd ../authz-fs && npm test
cd ../authz-testing && npm test
cd ../users && npm test
```

Expected: everything passes, beyond the baseline. In authz-http, `explain.test.ts` and `access-policy.test.ts` must pass unchanged: they set `configuration.isProduction` in the root Configuration, which the `@Config` properties now read.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host/env.ts packages/authz/test/host/defaults.test.ts packages/authz-http/src/access/policy.ts packages/authz-http/src/explain/source.ts
git commit -m "refactor(authz): isProduction takes the caller's @Config flag" -m "The callers read configuration.isProduction with @Config; only an unset flag falls back to APP_ENV / NODE_ENV, a non-boolean no longer does."
```

---

## Out of scope for this plan (recorded so they are not lost)

- `testHost`'s `TestConfiguration` (`packages/authz-testing/src/host/support.ts`) never applies schemas. Once it does, drop the code fallbacks: the `AUTHZ_DEFAULTS` merge base, the `ADMIN_DEFAULTS` `defaultValue`s, and `defaults = {}`.
- The `authz.admin.connection` default (Phase 5, together with authz-rbac `storeConnection`'s fallback chain).
- `readGuardConfig` (authz-rbac) and `AccountGuard` (users-http) still check `authz.admin.guard` by hand. Phase 5 deletes the checks, and the schema rule from 4.3 replaces them.
- The authz-http `readDomainConfig` callers and authz-orm `domainConfig` still read the root Configuration through `DI.get`. Phase 5 decides whether they move to `@Config` on their classes.
- No schema covers `configuration.isProduction` (`@spinajs/configuration`).
