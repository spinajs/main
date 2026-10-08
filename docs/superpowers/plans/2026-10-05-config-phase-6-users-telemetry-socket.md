# Config Phase 6: users, telemetry, http-socket through `@Config` and JSON schemas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `users`, `telemetry` and `http-socket` stop reading `Configuration` by hand and stop validating by hand. Values come from `@Config`; shape rules and defaults come from JSON schemas. Code keeps only DI lookups, compiling and checks a schema cannot express.

**Branch:** `authz-v3-refactor`. **Source of the rows:** `.superpowers/sdd/phase-6-inventory.md`, verified against the current code on 2026-10-05.

**Preconditions (other phases):**
- Phase 0 mechanism (`@Config` injecting the resolving container, `InvalidConfiguration.violations[].path`, `$data`, schema lineage, `registerConfigurationSchema`) is merged. The hidden key is `CONFIGURATION_CONTAINER_KEY` (exported by `@spinajs/configuration`); it holds a **container**, not a Configuration.
- Phase 4 is merged before Tasks 6.1 and 6.2 (both edit `packages/authz/src/host/config/schema.ts`; apply the fragments below onto Phase 4's version of the file).
- Phase 5 is merged before Task 6.3 (edits `packages/authz-rbac/src/stores/schema.ts`, which Phase 5 also edits).
- Phase 3 owns the `http` schema (`RealIp`, `CorsMiddleware`, `ThrottleMiddleware`, `trustProxy`, `cookie.secret`, `cors`, `throttle`). **Not planned here.** Task 6.5 needs one fact from it: the `http` schema root must stay open (no `additionalProperties: false`), or `removeAdditional` strips `http.socket`. Verify before starting 6.5.
- Phase 5 owns users-http `DefaultAccountGuard` (`authz.admin.guard`). **Not planned here.**

## Decisions this plan takes

1. **Schema homes.**
   - `authz.impersonation.*` and `authz.principals.roleSwitch.requirePassword` -> `AUTHZ_CONFIGURATION_SCHEMA` (authz keys).
   - `authz.rbac.defaultRoles` -> `AUTHZ_RBAC_CONFIGURATION_SCHEMA` (already declares it).
   - `authz.http.access.domain` -> a small schema **owned by users** (`$configurationModule: 'authz.http.access'`). authz-http owns `authz.http`, but users reads this key without depending on authz-http, so without its own schema the key would be unvalidated whenever authz-http is absent. Both schemas say `minLength: 1, default: 'root'`, so they agree when both are registered (a bad value then reports the same path twice; tests use `include`).
   - `telemetry.auth.*` -> new `TELEMETRY_CONFIGURATION_SCHEMA` in packages/telemetry, registered in `TelemetryBootstrapper` (before the existing `await DI.resolve(Configuration)`, which stays).
   - `http.socket` -> **an http-socket-owned schema** (`$configurationModule: 'http.socket'`), not a block in the Phase 3 `http` schema. Reasons: http-socket is optional and `packages/http` cannot depend on it; the schema ships with the package that reads the keys (the authz-rbac schema next to the authz one is the precedent: a dotted module path validates its subtree and runs beside the parent module); it avoids an edit conflict with Phase 3.
2. **Defaults live in the schema AND stay as `defaultValue` on `@Config`**, where a default existed in code. Reason: `authz-testing`'s `TestConfiguration` (used by the users and telemetry suites through `testHost`) is an in-memory configuration that applies no schema and no defaults; without `defaultValue` those suites would read `undefined`. A test per task pins schema default == exported constant, so the two cannot drift. This is a deliberate deviation from "defaults only in the schema"; the alternative (seeding every default in `testHost`) touches dozens of tests.
3. **Type coercion.** The Configuration's Ajv runs with `coerceTypes: true`. A number given for a string key becomes a string, `'true'` becomes `true`, `'1024'` becomes `1024`. The old hand checks were stricter. Tests therefore use `''`, `{}` and `[]` as bad values, never a number for a string key. Record this in the commit body of each task.
4. **Plain functions cannot use `@Config`.** `accessDomain`/`impersonationPermission`/`protectedRoles` become properties on the classes that call them; `create()` and `telemetrySkipsAuth()` stay functions reading through `cfg`/`DI` (see the tasks).
5. **Tests that boot a bad value go through a child Configuration** (`bootChild`, below), never `Configuration.set` on the root. Runtime `set` is not validated. Existing tests that set a malformed value at runtime and expect a hand-made error move to the schema tests.
6. **Test isolation:** no `DI.clear()`; children of `DI.RootContainer`, disposed in `afterEach`. Register the child's Configuration class before registering schemas, or `registerConfigurationSchema` validates the root's resolved Configuration against the new schema.

## Task order and parallelism

```
Phase 4 -> 6.1 -> 6.2           (users, sequential: same files, same suite)
Phase 5 -> 6.3                  (users + authz-rbac schema; file-disjoint from 6.1/6.2)
none    -> 6.4                  (telemetry)
Phase 3 verified -> 6.5         (http-socket)
```

- Parallel groups: **A** = 6.1 then 6.2 then 6.3 (6.3 may be authored in a second worktree, but merge before the final users suite run); **B** = 6.4; **C** = 6.5. B and C touch no file of A and no file of each other.
- Test runs are sequential (global constraint), including across groups: they rebuild `lib/` of shared packages (authz, authz-rbac).
- Each task ends with a commit; one commit per task.

## Shared test helper (create once per package that needs it)

`packages/users/test/support/child-config.ts`, `packages/telemetry/test/support/child-config.ts` and `packages/http-socket/test/child-config.ts` have the same content:

```ts
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';

const booted: IContainer[] = [];

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class ChildConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

/** A child container with its own Configuration over `values`, resolved before anything reads it. */
export async function bootChild(values: Record<string, unknown>, ...schemas: object[]): Promise<{ child: IContainer; config: Configuration }> {
  const child = DI.RootContainer.child();
  booted.push(child);
  child.register(configurationOf(values)).as(Configuration);
  for (const schema of schemas) registerConfigurationSchema(schema, child);
  return { child, config: await child.resolve(Configuration) };
}

/** The `path` of every violation of a boot that must fail with InvalidConfiguration. */
export async function violationPaths(values: Record<string, unknown>, ...schemas: object[]): Promise<string[]> {
  try {
    await bootChild(values, ...schemas);
  } catch (e) {
    if (!(e instanceof InvalidConfiguration)) throw e;
    return e.violations.map((v) => v.path);
  }
  throw new Error('expected InvalidConfiguration, the boot succeeded');
}

export async function disposeChildren(): Promise<void> {
  for (const c of booted.splice(0).reverse()) await c.dispose();
}
```

---

### Task 6.1: users target guard, impersonation guard, access response and role source read the access domain, impersonation permission and protected roles from `@Config`

Inventory row: users `target-guard.ts` (`accessDomain`, `impersonationPermission`, `protectedRoles`).

**Files:**
- Modify: `packages/authz/src/host/config/schema.ts` (`properties` of `AUTHZ_CONFIGURATION_SCHEMA`, after `principals`, currently lines 97-103; and the comment above the schema, lines 69-71)
- Create: `packages/users/src/authn/access-schema.ts`
- Modify: `packages/users/src/authn/target-guard.ts` (imports lines 1-11; delete `accessDomain()` lines 37-49, `impersonationPermission()` lines 51-57, `protectedRoles()` lines 59-65 and the `configuration()` helper after `users()`; class `AuthzTargetGuard` from line 94)
- Modify: `packages/users/src/authn/impersonation-guard.ts` (imports lines 1-8; class body lines 22-44)
- Modify: `packages/users/src/authn/access-response.ts` (imports lines 1-9; class `AccessResponseExtension`, lines 17-26)
- Modify: `packages/users/src/authn/rbac-role-source.ts` (imports lines 1-8; class `RbacRoleSource`, lines 31-44; the `passwordRule` part is Task 6.2)
- Modify: `packages/users/src/authn/index.ts`, `packages/users/src/index.ts` (`RbacBootstrapper.bootstrap`, line 60 and imports lines 1-12)
- Create: `packages/users/test/support/child-config.ts` (the helper above), `packages/users/test/config-access-guards.test.ts`

**Interfaces:**
- Consumes: `@Config`, `CONFIGURATION_CONTAINER_KEY`, `registerConfigurationSchema` from `@spinajs/configuration`; `AUTHZ_CONFIGURATION_SCHEMA` from `@spinajs/authz`.
- Produces: `DEFAULT_ACCESS_DOMAIN`, `USERS_ACCESS_CONFIGURATION_SCHEMA` (exported from users); `accessDomain(name: string): Promise<AccessDomain>` (the DI lookup only; no longer reads configuration); protected `@Config` properties `AccessDomain` on `AuthzTargetGuard`, `AuthzImpersonationGuard`, `AccessResponseExtension`, `RbacRoleSource`; `ProtectedRoles` on `AuthzTargetGuard`; `Permission` on `AuthzImpersonationGuard`. `impersonationPermission()` and `protectedRoles()` are deleted (neither is exported from the package barrel; `authn/index.ts` exports only the names it lists).

`@Config` applies: all four are classes. `AuthzTargetGuard` and `AccessResponseExtension` are also built with `new` (inside `AuthzImpersonationGuard.allowed` and `buildUserWithAccess`); an instance built with `new` reads the root Configuration, which is what `DI.resolve(Configuration)` returned before, so nothing regresses.

What a schema cannot express and stays in code: the lookup of the domain's container and service (`AuthzDomains`), `registeredInDomain` (is an `RbacService` registered in that domain), the reachable-role closure.

- [ ] **Step 1: Schema additions**

In `packages/authz/src/host/config/schema.ts`, add the block as a sibling after `principals` (apply it onto Phase 4's version; if Phase 4 reshaped `principals`, keep the position next to it):

```ts
    impersonation: {
      type: 'object',
      default: {},
      properties: {
        permission: { type: 'string', minLength: 1, default: 'user:impersonate' },
        protectedRoles: { type: 'array', items: { type: 'string', minLength: 1 }, default: ['admin'] },
      },
    },
```

Replace the comment line above `AUTHZ_CONFIGURATION_SCHEMA` (`// No \`default\` keywords: defaults live in AUTHZ_DEFAULTS, ...`) with:

```ts
// No `default` keywords for keys authz reads: those live in AUTHZ_DEFAULTS, so a config without `authz` behaves the same.
// `impersonation` is read by users, which has no AUTHZ_DEFAULTS entry, so its defaults are here.
```

Create `packages/users/src/authn/access-schema.ts`:

```ts
export const DEFAULT_ACCESS_DOMAIN = 'root';

// authz-http owns authz.http; users reads the access domain without depending on it, so it validates the key itself.
export const USERS_ACCESS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/users-access.configuration.schema.json',
  $configurationModule: 'authz.http.access',
  description: 'The authz domain users judges access in (authz.http.access.*)',
  type: 'object',
  properties: {
    domain: { type: 'string', minLength: 1, default: DEFAULT_ACCESS_DOMAIN },
  },
};
```

In `packages/users/src/authn/index.ts`, add as the last line:

```ts
export * from './access-schema.js';
```

In `packages/users/src/index.ts`, change the configuration import to `import { Configuration, registerConfigurationSchema } from '@spinajs/configuration';`, add `import { USERS_ACCESS_CONFIGURATION_SCHEMA } from './authn/access-schema.js';` after the `import type { IRbacAsyncStorage }` line, and make the first statement of `RbacBootstrapper.bootstrap()`:

```ts
    registerConfigurationSchema(USERS_ACCESS_CONFIGURATION_SCHEMA);
```

- [ ] **Step 2: Write the failing tests**

Create `packages/users/test/support/child-config.ts` with the shared helper (above). Create `packages/users/test/config-access-guards.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';

import { AccessResponseExtension, AuthzImpersonationGuard, AuthzTargetGuard, DEFAULT_ACCESS_DOMAIN, DEFAULT_IMPERSONATION_PERMISSION, DEFAULT_PROTECTED_ROLES, RbacRoleSource, USERS_ACCESS_CONFIGURATION_SCHEMA } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const SCHEMAS = [AUTHZ_CONFIGURATION_SCHEMA, USERS_ACCESS_CONFIGURATION_SCHEMA];

const read = (instance: object, property: string): unknown => (instance as unknown as Record<string, unknown>)[property];

describe('users access domain and impersonation configuration', () => {
  afterEach(disposeChildren);

  describe('defaults', () => {
    it('gives an unconfigured app the values the code defaults used to give', async () => {
      const { config } = await bootChild({}, ...SCHEMAS);

      expect(config.get('authz.impersonation')).to.deep.equal({ permission: DEFAULT_IMPERSONATION_PERMISSION, protectedRoles: [...DEFAULT_PROTECTED_ROLES] });
      expect(config.get('authz.http.access.domain')).to.equal(DEFAULT_ACCESS_DOMAIN);
    });

    it('keeps an empty protectedRoles list, which turns the protected-role rule off', async () => {
      const { config } = await bootChild({ authz: { impersonation: { protectedRoles: [] } } }, ...SCHEMAS);

      expect(config.get('authz.impersonation.protectedRoles')).to.deep.equal([]);
    });
  });

  describe('a bad value fails the boot with the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['an empty permission', { authz: { impersonation: { permission: '' } } }, 'authz.impersonation.permission'],
      ['a permission that is not a string', { authz: { impersonation: { permission: {} } } }, 'authz.impersonation.permission'],
      ['protectedRoles that is not a list', { authz: { impersonation: { protectedRoles: 'admin' } } }, 'authz.impersonation.protectedRoles'],
      ['an empty role name', { authz: { impersonation: { protectedRoles: ['admin', ''] } } }, 'authz.impersonation.protectedRoles.1'],
      ['a role name that is not a string', { authz: { impersonation: { protectedRoles: [{}] } } }, 'authz.impersonation.protectedRoles.0'],
      ['an empty access domain', { authz: { http: { access: { domain: '' } } } }, 'authz.http.access.domain'],
      ['an access domain that is not a string', { authz: { http: { access: { domain: [] } } } }, 'authz.http.access.domain'],
    ];

    for (const [label, values, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(values, ...SCHEMAS)).to.include(path);
      });
    }
  });

  describe('@Config reads the configuration of the container that builds the instance', () => {
    const configured = { authz: { http: { access: { domain: 'tenant' } }, impersonation: { permission: 'user:take-over', protectedRoles: ['member'] } } };

    it('AuthzImpersonationGuard', async () => {
      const { child } = await bootChild(configured, ...SCHEMAS);
      const guard = await child.resolve(AuthzImpersonationGuard);

      expect(read(guard, 'AccessDomain')).to.equal('tenant');
      expect(read(guard, 'Permission')).to.equal('user:take-over');
    });

    it('AccessResponseExtension and RbacRoleSource', async () => {
      const { child } = await bootChild(configured, ...SCHEMAS);

      expect(read(await child.resolve(AccessResponseExtension), 'AccessDomain')).to.equal('tenant');
      expect(read(await child.resolve(RbacRoleSource), 'AccessDomain')).to.equal('tenant');
    });

    it('AuthzTargetGuard built with new, once it is handed the container', async () => {
      const { child } = await bootChild(configured, ...SCHEMAS);
      const guard = new AuthzTargetGuard();
      (guard as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;

      expect(read(guard, 'AccessDomain')).to.equal('tenant');
      expect(read(guard, 'ProtectedRoles')).to.deep.equal(['member']);
    });
  });
});
```

The existing behaviour tests (`test/impersonation-guard.test.ts`, `test/v3/impersonation.test.ts`, `test/rbac-role-source.test.ts`, `test/access-response.test.ts`) stay as they are: they set the keys on the root Configuration, which an instance built with `new` or by the root container reads. No test asserts a hand-made `AuthzConfigError` for these three keys (checked: `AuthzConfigError` in `impersonation-guard.test.ts` is only about a missing `RbacService`).

- [ ] **Step 3: RED**

Run: `cd packages/authz && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `cd ../users && npx ts-mocha -p tsconfig.json test/config-access-guards.test.ts`.
Expected: the `defaults` and `a bad value fails the boot` groups PASS (the schemas from Step 1 exist). The three `@Config` tests FAIL with `AssertionError: expected undefined to equal 'tenant'` (the properties do not exist yet).

- [ ] **Step 4: Implement**

`packages/users/src/authn/target-guard.ts`:

1. Imports: replace `import { Configuration } from '@spinajs/configuration';` with `import { Config } from '@spinajs/configuration';` and add after the `UserPrincipalFactory` import:

```ts
import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
```

2. Replace `accessDomain()` (lines 37-49) with the lookup only, and delete `impersonationPermission()` and `protectedRoles()` (lines 51-65) and the `configuration()` helper that follows `users()`:

```ts
export async function accessDomain(name: string): Promise<AccessDomain> {
  if (name === 'root') {
    return { name, container: DI.RootContainer, service: async () => (await DI.resolve(AuthzService)) as AuthzService };
  }

  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return { name, container: domains.container(name), service: () => domains.service(name) };
}
```

3. `AuthzTargetGuard`: add the two properties before the constructor, and use them in `check`:

```ts
export class AuthzTargetGuard {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  @Config(PROTECTED_ROLES_KEY, { defaultValue: DEFAULT_PROTECTED_ROLES })
  protected ProtectedRoles: readonly string[];

  constructor(private readonly opts: AuthzTargetGuardOptions = {}) {}
```

and in `check`:

```ts
    const domain = await accessDomain(this.AccessDomain);
    const rbac = await registeredInDomain(domain, RbacService);
    const authz = await domain.service();

    const guarded = this.ProtectedRoles;
```

Also change the class doc line `@throws AuthzConfigError when the access domain has no RbacService of its own, or the config is malformed` to end after `of its own`.

`packages/users/src/authn/impersonation-guard.ts`: imports become

```ts
import { GLOBAL } from '@spinajs/authz';
import { ImpersonationGuard, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import { UserIsBanned, UserNotActive } from '../exceptions.js';
import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
import { ACCESS_DOMAIN_KEY, AuthzTargetGuard, DEFAULT_IMPERSONATION_PERMISSION, IMPERSONATION_PERMISSION_KEY, accessDomain, actingFacts, signedInInteractively } from './target-guard.js';
```

and in the class, before the constructor and in `allowed`:

```ts
export class AuthzImpersonationGuard extends ImpersonationGuard {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  @Config(IMPERSONATION_PERMISSION_KEY, { defaultValue: DEFAULT_IMPERSONATION_PERMISSION })
  protected Permission: string;

  constructor(private readonly opts: AuthzImpersonationGuardOptions = {}) {
    super();
  }
```

```ts
    const authz = await (await accessDomain(this.AccessDomain)).service();
    if (!(await authz.can(actor, this.Permission, GLOBAL))) {
      return FORBIDDEN;
    }
```

`packages/users/src/authn/access-response.ts`: add `import { Config } from '@spinajs/configuration';` after the `AuthnResponseExtension` import, replace `import { accessDomain } from './target-guard.js';` with

```ts
import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
import { ACCESS_DOMAIN_KEY, accessDomain } from './target-guard.js';
```

and the class body with:

```ts
export class AccessResponseExtension extends AuthnResponseExtension {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  public async extend(_kind: ResponseKind, principal: Principal, body: Record<string, unknown>): Promise<void> {
    body.Access = await (await (await accessDomain(this.AccessDomain)).service()).summary(principal);
  }
}
```

`packages/users/src/authn/rbac-role-source.ts` (access domain only; `passwordRule` is Task 6.2): add `import { Config } from '@spinajs/configuration';` after the `RbacService` import (keep the existing `Configuration` import until 6.2), change the target-guard import to

```ts
import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
import { ACCESS_DOMAIN_KEY, accessDomain, heldRoles, registeredInDomain, signedInInteractively } from './target-guard.js';
```

add before `rolesOf`:

```ts
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;
```

and change `const domain = await accessDomain();` to `const domain = await accessDomain(this.AccessDomain);`.

- [ ] **Step 5: GREEN, package suite, dependants**

Run, sequentially:
1. `cd packages/users && npx ts-mocha -p tsconfig.json test/config-access-guards.test.ts` -> all pass.
2. `npx ts-mocha -p tsconfig.json test/impersonation-guard.test.ts test/v3/impersonation.test.ts test/rbac-role-source.test.ts test/access-response.test.ts` -> pass.
3. `npm test` in `packages/users` (compiles first).
4. Rebuild users: `npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `npm test` in `packages/authz` (schema change), `packages/authz-convert` (its golden test compiles `AUTHZ_CONFIGURATION_SCHEMA`), `packages/users-http`, `packages/authn-http`, `packages/authn-token`, `packages/authn-totp`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host/config/schema.ts packages/users/src packages/users/test/support/child-config.ts packages/users/test/config-access-guards.test.ts
git commit -m "refactor(users): access domain, impersonation permission and protected roles through @Config and the schema"
```

Commit body: a non-string or empty value now fails the boot with `InvalidConfiguration` (was `AuthzConfigError` at first use); Ajv coercion turns a number into a string for these keys.

---

### Task 6.2: `RbacRoleSource` reads `authz.principals.roleSwitch.requirePassword` from `@Config`

Inventory row: users `RbacRoleSource.passwordRule`. Depends on 6.1 (same file, same suite).

**Files:**
- Modify: `packages/authz/src/host/config/schema.ts` (`principals.properties.roleSwitch`, currently line 101)
- Modify: `packages/users/src/authn/rbac-role-source.ts` (imports lines 1-6; constants lines 10-14; class; delete `passwordRule()` lines 46-61 after 6.1)
- Create: `packages/users/test/config-role-switch.test.ts`
- Modify: `packages/users/test/rbac-role-source.test.ts` (delete the test `rejects a malformed authz.principals.roleSwitch.requirePassword`, lines 129-135)

**Interfaces:**
- Consumes: `bootChild`, `violationPaths` (Task 6.1 helper); `@Config`.
- Produces: protected `@Config` properties `RequirePassword` (3.0 key) and `LegacyRequirePassword` (2.x key) on `RbacRoleSource`.

Flag: the 2.x key `rbac.roleSwitch.requirePassword` is a deprecated path (R1 deletes it) and has no schema. `@Config` applies to it, but its list-shape check stays in code, because no schema can cover it. It is the only hand check left in this file.

- [ ] **Step 1: Schema additions**

In `AUTHZ_CONFIGURATION_SCHEMA.properties.principals.properties` (Phase 4's version), replace the `roleSwitch` entry with a form that allows `null` (the code treats `null` as unset) and rejects empty role names (the code rejected them):

```ts
        roleSwitch: {
          type: 'object',
          properties: {
            requirePassword: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
          },
        },
```

- [ ] **Step 2: Write the failing tests**

Create `packages/users/test/config-role-switch.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';

import { RbacRoleSource, ROLE_SWITCH_PASSWORD_KEY } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const configured = (value: unknown) => ({ authz: { principals: { roleSwitch: { requirePassword: value } } } });
const read = (instance: object, property: string): unknown => (instance as unknown as Record<string, unknown>)[property];

describe('authz.principals.roleSwitch.requirePassword', () => {
  afterEach(disposeChildren);

  for (const bad of ['support', [''], [{}], [['support']]]) {
    it(`fails the boot for ${JSON.stringify(bad)}, naming the key`, async () => {
      expect(await violationPaths(configured(bad), AUTHZ_CONFIGURATION_SCHEMA)).to.include(ROLE_SWITCH_PASSWORD_KEY);
    });
  }

  for (const good of [[], ['support'], ['support', 'member'], null]) {
    it(`boots with ${JSON.stringify(good)}`, async () => {
      const { config } = await bootChild(configured(good), AUTHZ_CONFIGURATION_SCHEMA);

      expect(config.get(ROLE_SWITCH_PASSWORD_KEY)).to.deep.equal(good);
    });
  }

  it('RbacRoleSource reads the 3.0 and the 2.x key from the container that builds it', async () => {
    const { child } = await bootChild({ authz: { principals: { roleSwitch: { requirePassword: ['support'] } } }, rbac: { roleSwitch: { requirePassword: ['member'] } } }, AUTHZ_CONFIGURATION_SCHEMA);
    const source = await child.resolve(RbacRoleSource);

    expect(read(source, 'RequirePassword')).to.deep.equal(['support']);
    expect(read(source, 'LegacyRequirePassword')).to.deep.equal(['member']);
  });
});
```

In `packages/users/test/rbac-role-source.test.ts`, delete the whole test `it('rejects a malformed authz.principals.roleSwitch.requirePassword', ...)` (the schema test above replaces it). The tests of the 2.x key (`reads the 2.x ...`, `rejects a malformed 2.x key ...`) and the null/precedence tests stay: they set values on the root Configuration at runtime and exercise the code that remains.

- [ ] **Step 3: RED**

Run: `cd packages/authz && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `cd ../users && npx ts-mocha -p tsconfig.json test/config-role-switch.test.ts`.
Expected: the schema cases PASS (Step 1 is in place); `RbacRoleSource reads the 3.0 and the 2.x key ...` FAILS with `expected undefined to deeply equal [ 'support' ]`.

- [ ] **Step 4: Implement**

In `packages/users/src/authn/rbac-role-source.ts`: imports become

```ts
import { AuthzConfigError } from '@spinajs/authz';
import { RoleSource } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { RbacService } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
```

Replace the class and delete the free function `passwordRule()`:

```ts
@Injectable(RoleSource)
export class RbacRoleSource extends RoleSource {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  @Config(ROLE_SWITCH_PASSWORD_KEY)
  protected RequirePassword: readonly string[] | null | undefined;

  @Config(LEGACY_ROLE_SWITCH_PASSWORD_KEY)
  protected LegacyRequirePassword: unknown;

  public async rolesOf(principal: Principal): Promise<readonly RoleOffer[]> {
    if (principal.type !== 'user' || principal.onBehalfOf || (principal.authn != null && !signedInInteractively(principal.authn))) {
      return [];
    }

    const domain = await accessDomain(this.AccessDomain);
    const rbac = await registeredInDomain(domain, RbacService);
    const requiresPassword = this.passwordRule();
    const names = [...new Set(await heldRoles(rbac, domain.name, principal))].sort();
    return names.map((role) => ({ role, requirePassword: requiresPassword(role) }));
  }

  private passwordRule(): (role: string) => boolean {
    const listed = this.RequirePassword ?? this.legacyList();
    // Fail safe, as the 2.x switch: no list configured means every switch re-verifies the password.
    if (listed === undefined) return () => true;
    const set = new Set<string>(listed);
    return (role) => set.has(role);
  }

  private legacyList(): readonly string[] | undefined {
    const value = this.LegacyRequirePassword;
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && r !== '')) {
      throw new AuthzConfigError(`${LEGACY_ROLE_SWITCH_PASSWORD_KEY} must be a list of role names, got ${JSON.stringify(value)}`);
    }
    return value as string[];
  }
}
```

The class doc keeps its text except the final `@throws` line, which now reads `@throws AuthzConfigError when the access domain has no RbacService of its own, or the 2.x key is malformed`.

- [ ] **Step 5: GREEN, package suite, dependants**

Run, sequentially: `npx ts-mocha -p tsconfig.json test/config-role-switch.test.ts test/rbac-role-source.test.ts` in `packages/users`, then `npm test` in `packages/users`; rebuild authz and users (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json` in each) and run `npm test` in `packages/authz`, `packages/authn-http`, `packages/authn-token`, `packages/authn-totp` (they use `RoleSource` through users).
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/host/config/schema.ts packages/users/src/authn/rbac-role-source.ts packages/users/test/config-role-switch.test.ts packages/users/test/rbac-role-source.test.ts
git commit -m "refactor(users): authz.principals.roleSwitch.requirePassword through @Config and the schema"
```

---

### Task 6.3: `DefaultRolesBootCheck` and `create()` take `authz.rbac.defaultRoles` from `@Config` / the schema

Inventory row: users `defaultRoles`, `DefaultRolesBootCheck`. Depends on Phase 5 (shares `AUTHZ_RBAC_CONFIGURATION_SCHEMA`). File-disjoint from 6.1/6.2.

**Files:**
- Modify: `packages/authz-rbac/src/stores/schema.ts:66` (`defaultRoles`)
- Modify: `packages/users/src/role-assignments.ts:25-35` (delete `defaultRoles()`; keep `DEFAULT_ROLES_KEY`)
- Modify: `packages/users/src/default-roles-check.ts:1-35` (imports, class head, `contribute` head)
- Modify: `packages/users/src/actions.ts:22` (import) and `:664` (the `create` role fallback)
- Create: `packages/users/test/config-default-roles.test.ts`
- Modify: `packages/users/test/create.test.ts:267-283` (drop the two type cases)

**Interfaces:**
- Consumes: `bootChild`, `violationPaths`, `AUTHZ_RBAC_CONFIGURATION_SCHEMA` from `@spinajs/authz-rbac`.
- Produces: protected `@Config` property `DefaultRoles` on `DefaultRolesBootCheck`; `defaultRoles()` is deleted (it is not exported from the barrel; `role-assignments.ts` is not re-exported by `src/index.ts`).

`@Config` cannot apply to `create()` (a plain exported function): it keeps reading through `cfg(DEFAULT_ROLES_KEY, [])`, minus the shape check. What stays in code in the boot check: the RoleStore registration lookup, loading and compiling the roles, `assignmentProblem` (assignable, allowed at GLOBAL), and de-duplication (`new Set`), which is not validation.

- [ ] **Step 1: Schema additions**

In `packages/authz-rbac/src/stores/schema.ts`, replace `defaultRoles: stringList,` with:

```ts
    // Non-blank and no edge whitespace: create() used to trim, a padded name now fails the boot instead.
    defaultRoles: { type: 'array', items: { type: 'string', pattern: '^\\S(?:.*\\S)?$' } },
```

No `default` keyword: an unset key means "no default roles", and `@Config` carries `defaultValue: []`.

- [ ] **Step 2: Write the failing tests**

Create `packages/users/test/config-default-roles.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from '@spinajs/authz-rbac';

import { DEFAULT_ROLES_KEY } from '../src/role-assignments.js';
import { DefaultRolesBootCheck } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const configured = (value: unknown) => ({ authz: { rbac: { defaultRoles: value } } });

describe('authz.rbac.defaultRoles', () => {
  afterEach(disposeChildren);

  const bad: Array<[string, unknown, string]> = [
    ['a string', 'user', DEFAULT_ROLES_KEY],
    ['an empty role name', ['user', ''], `${DEFAULT_ROLES_KEY}.1`],
    ['a blank role name', ['   '], `${DEFAULT_ROLES_KEY}.0`],
    ['a role name with leading whitespace', [' user'], `${DEFAULT_ROLES_KEY}.0`],
    ['a role name with trailing whitespace', ['user '], `${DEFAULT_ROLES_KEY}.0`],
    ['a role name that is not a string', [{}], `${DEFAULT_ROLES_KEY}.0`],
  ];

  for (const [label, value, path] of bad) {
    it(`fails the boot for ${label}, naming the bad key`, async () => {
      expect(await violationPaths(configured(value), AUTHZ_RBAC_CONFIGURATION_SCHEMA)).to.include(path);
    });
  }

  it('boots with a list of role names and with none at all', async () => {
    expect((await bootChild(configured(['user', 'editor']), AUTHZ_RBAC_CONFIGURATION_SCHEMA)).config.get(DEFAULT_ROLES_KEY)).to.deep.equal(['user', 'editor']);
    expect((await bootChild({}, AUTHZ_RBAC_CONFIGURATION_SCHEMA)).config.get(DEFAULT_ROLES_KEY)).to.equal(undefined);
  });

  it('DefaultRolesBootCheck reads them from the container that builds it', async () => {
    const { child } = await bootChild(configured(['user']), AUTHZ_RBAC_CONFIGURATION_SCHEMA);
    const check = await child.resolve(DefaultRolesBootCheck);

    expect((check as unknown as Record<string, unknown>).DefaultRoles).to.deep.equal(['user']);
  });
});
```

In `packages/users/test/create.test.ts`, in the table of `describe('authz.rbac.defaultRoles boot check (L1-1)')`, delete the two type rows (the schema test above covers them):

```ts
      ['user', 'must be an array of role names'],
      [['user', 7], 'must be an array of role names'],
```

The rows `[['ghost'], "role 'ghost'"]` and `[['admin.users'], "role 'admin.users'"]` stay: they are DI and compile checks the schema cannot make.

- [ ] **Step 3: RED**

Run: `cd packages/authz-rbac && npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`, then `cd ../users && npx ts-mocha -p tsconfig.json test/config-default-roles.test.ts`.
Expected: the schema cases PASS; `DefaultRolesBootCheck reads them ...` FAILS with `expected undefined to deeply equal [ 'user' ]`.

- [ ] **Step 4: Implement**

`packages/users/src/role-assignments.ts`: delete the `defaultRoles` function and its doc line (lines 25-35). `AuthzConfigError` stays imported (`assignmentStore()` uses it).

`packages/users/src/default-roles-check.ts`: imports and the head of `contribute` become

```ts
import { AuthzConfigError, AuthzContributor, GLOBAL } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { RoleStore, assignmentProblem, compileRoles } from '@spinajs/authz-rbac';
import type { LadderDef, RoleDef } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';

import { DEFAULT_ROLES_KEY } from './role-assignments.js';
```

```ts
export class DefaultRolesBootCheck extends AuthzContributor {
  @Config(DEFAULT_ROLES_KEY, { defaultValue: [] })
  protected DefaultRoles: readonly string[];

  public async contribute(domain: string): Promise<AuthzContribution> {
    if (domain !== 'root') {
      return {};
    }

    const roles = [...new Set(this.DefaultRoles)];
    if (roles.length === 0) {
      return {};
    }
```

(the rest of the method is unchanged).

`packages/users/src/actions.ts`: line 22 drops `defaultRoles` from the import:

```ts
import { DEFAULT_ROLES_KEY, assignGlobalRoles, globalRoleHolders, holdsGlobalRole, revokeGlobalRole, userRef } from './role-assignments.js';
```

and line 664 becomes:

```ts
  const roleNames = asked.length > 0 ? asked : [...new Set(cfg<string[]>(DEFAULT_ROLES_KEY, []))];
```

- [ ] **Step 5: GREEN, package suite, dependants**

Run, sequentially: `npx ts-mocha -p tsconfig.json test/config-default-roles.test.ts test/create.test.ts test/v3/role-grants.test.ts test/v3/user-roles.test.ts` in `packages/users`, then `npm test` in `packages/users` and in `packages/authz-rbac`; rebuild users and run `npm test` in `packages/users-http` (it creates users through `create()`).
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/stores/schema.ts packages/users/src/role-assignments.ts packages/users/src/default-roles-check.ts packages/users/src/actions.ts packages/users/test/config-default-roles.test.ts packages/users/test/create.test.ts
git commit -m "refactor(users): authz.rbac.defaultRoles through @Config and the schema, no hand validation"
```

Commit body: a role name with edge whitespace now fails the boot; `create()` used to trim it.

---

### Task 6.4: telemetry `telemetry.auth.*` through `@Config` and a telemetry schema

Inventory row: telemetry `TelemetryAccessPolicy`, `TelemetryAccessContributor`, `telemetrySkipsAuth`.

**Files:**
- Create: `packages/telemetry/src/schema.ts` (not under `src/config/`: files there are loaded as configuration)
- Modify: `packages/telemetry/src/index.ts` (add an export)
- Modify: `packages/telemetry/src/bootstrap.ts:1-18` (`TelemetryBootstrapper`)
- Modify: `packages/telemetry/src/policies/TelemetryAccessPolicy.ts` (imports lines 1-12; class lines 40-110; contributor lines 116-143)
- Create: `packages/telemetry/test/support/child-config.ts`, `packages/telemetry/test/auth-config.test.ts`
- Modify: `packages/telemetry/test/bootstrappers.test.ts` (one test), `packages/telemetry/test/access-policy.test.ts` (delete five tests), `packages/telemetry/test/contributor.test.ts` (delete one test)

**Interfaces:**
- Consumes: `registerConfigurationSchema`, `Config`; `PERMISSION_PATTERN` from `@spinajs/authz`.
- Produces: `TELEMETRY_CONFIGURATION_SCHEMA`; protected `@Config` properties `Policies`, `Permissions`, `Domain` on `TelemetryAccessPolicy`; `Domain`, `Policies`, `Permissions` on `TelemetryAccessContributor`.

What `@Config` cannot do here, and how it is handled:
- The slot and permission keys are per endpoint (`telemetry.auth.policies.<endpoint>`); a `@Config` path is static. The classes read the whole `policies` / `permissions` maps and index them by endpoint.
- Stays in code: the endpoint name is a non-empty string (a constructor argument, not configuration); a slot or permission entry exists for this endpoint (the key set depends on the endpoint); an `'AccessPolicy'` slot has a permission entry (a rule across two maps); the slot does not name `TelemetryAccessPolicy` itself; the slot names a registered `BasePolicy` (DI lookup).
- `telemetrySkipsAuth()` is a plain function with an `env` argument and also reads `Configuration.Env` and `configuration.isProduction`, which are not `telemetry.auth.*`; `@Config` cannot apply. It is **left unchanged**; its `=== true` check on `telemetry.auth.skipInDevelopment` stays (it keeps the existing "flag not exactly true" test valid under the unvalidated in-memory configuration). The schema gives the key `type: 'boolean'` and `default: false`. `isProduction()` is Phase 4's.
- `TelemetryAccessPolicy` reads in its constructor, which runs before DI sets the hidden container key, so it reads the root Configuration, exactly what `DI.get(Configuration)` did. `TelemetryAccessContributor` is built by DI and reads its container's Configuration.

- [ ] **Step 1: Schema additions**

Create `packages/telemetry/src/schema.ts`:

```ts
import { PERMISSION_PATTERN } from '@spinajs/authz';

const name = { type: 'string', minLength: 1 };
const permission = { type: 'string', pattern: PERMISSION_PATTERN.source };

// Only the auth block is validated here; the other telemetry keys are @Config properties with code defaults.
export const TELEMETRY_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/telemetry.configuration.schema.json',
  $configurationModule: 'telemetry',
  description: 'Telemetry configuration (telemetry.auth.*)',
  type: 'object',
  properties: {
    auth: {
      type: 'object',
      default: {},
      properties: {
        token: { type: 'string' },
        skipInDevelopment: { type: 'boolean', default: false },
        domain: { ...name, default: 'root' },
        policies: { type: 'object', additionalProperties: name },
        permissions: { type: 'object', additionalProperties: { anyOf: [permission, { type: 'array', minItems: 1, items: permission }] } },
      },
    },
  },
};
```

In `packages/telemetry/src/index.ts` add after the `./bootstrap.js` export:

```ts
export * from './schema.js';
```

- [ ] **Step 2: Write the failing tests**

Create `packages/telemetry/test/support/child-config.ts` (the shared helper). Create `packages/telemetry/test/auth-config.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import fragment from '../src/config/telemetry.js';
import { TELEMETRY_CONFIGURATION_SCHEMA, TelemetryAccessContributor } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const auth = (value: Record<string, unknown>) => ({ telemetry: { auth: value } });

describe('telemetry.auth configuration', () => {
  afterEach(disposeChildren);

  it('gives an unconfigured app the code defaults', async () => {
    const { config } = await bootChild({}, TELEMETRY_CONFIGURATION_SCHEMA);

    expect(config.get('telemetry.auth')).to.deep.equal({ skipInDevelopment: false, domain: 'root' });
  });

  it('accepts the shipped telemetry configuration', async () => {
    await bootChild({ telemetry: fragment.telemetry }, TELEMETRY_CONFIGURATION_SCHEMA);
  });

  it('accepts a permission or a list of them per endpoint', async () => {
    await bootChild(auth({ policies: { a: 'AccessPolicy', b: 'PublicPolicy' }, permissions: { a: 'telemetry:read', b: ['telemetry:read', 'logs:read'] } }), TELEMETRY_CONFIGURATION_SCHEMA);
  });

  describe('a bad value fails the boot with the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['an empty domain', { domain: '' }, 'telemetry.auth.domain'],
      ['a domain that is not a string', { domain: {} }, 'telemetry.auth.domain'],
      ['a skip flag that is not a boolean', { skipInDevelopment: {} }, 'telemetry.auth.skipInDevelopment'],
      ['a token that is not a string', { token: {} }, 'telemetry.auth.token'],
      ['policies that is not a map', { policies: 'AccessPolicy' }, 'telemetry.auth.policies'],
      ['an empty slot', { policies: { metrics: '' } }, 'telemetry.auth.policies.metrics'],
      ['a slot that is not a string', { policies: { metrics: ['AccessPolicy'] } }, 'telemetry.auth.policies.metrics'],
      ['an empty permission', { permissions: { metrics: '' } }, 'telemetry.auth.permissions.metrics'],
      ['an empty permission list', { permissions: { metrics: [] } }, 'telemetry.auth.permissions.metrics'],
      ['a permission without an action', { permissions: { metrics: 'telemetry' } }, 'telemetry.auth.permissions.metrics'],
      ['a list with an invalid permission', { permissions: { metrics: ['telemetry:read', 'read'] } }, 'telemetry.auth.permissions.metrics'],
      ['a permission that is not a string or a list', { permissions: { metrics: {} } }, 'telemetry.auth.permissions.metrics'],
    ];

    for (const [label, value, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(auth(value), TELEMETRY_CONFIGURATION_SCHEMA)).to.include(path);
      });
    }
  });

  describe('TelemetryAccessContributor reads the configuration of the container that builds it', () => {
    const values = auth({ domain: 'tel', policies: { a: 'AccessPolicy', b: 'PublicPolicy', c: 'AccessPolicy' }, permissions: { a: 'telemetry:read', b: 'telemetry:read', c: ['telemetry:write', 'logs:read'] } });

    it("emits the permissions of each 'AccessPolicy' slot for the domain the slots check in", async () => {
      const { child } = await bootChild(values, TELEMETRY_CONFIGURATION_SCHEMA);
      const contributor = await child.resolve(TelemetryAccessContributor);

      expect(contributor.contribute('tel').permissionRefs).to.deep.eq([
        { permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' },
        { permission: 'telemetry:write', type: 'telemetry', source: 'telemetry.auth.permissions.c' },
        { permission: 'logs:read', type: 'logs', source: 'telemetry.auth.permissions.c' },
      ]);
      expect(contributor.contribute('root').permissionRefs).to.deep.eq([]);
    });

    it('checks in root when telemetry.auth.domain is not configured', async () => {
      const { child } = await bootChild(auth({ policies: { a: 'AccessPolicy' }, permissions: { a: 'telemetry:read' } }), TELEMETRY_CONFIGURATION_SCHEMA);
      const contributor = await child.resolve(TelemetryAccessContributor);

      expect(contributor.contribute('root').permissionRefs).to.deep.eq([{ permission: 'telemetry:read', type: 'telemetry', source: 'telemetry.auth.permissions.a' }]);
    });
  });
});
```

In `packages/telemetry/test/bootstrappers.test.ts`, change the import to `import { Metrics, TELEMETRY_CONFIGURATION_SCHEMA, TelemetryBootstrapper, TelemetryServiceTokenBootstrapper } from '../src/index.js';` and add inside the describe:

```ts
  it('TelemetryBootstrapper registers the telemetry configuration schema', async () => {
    await new TelemetryBootstrapper().bootstrap();
    expect(DI.RootContainer.Cache.get('__configurationSchema__', false) ?? []).to.include(TELEMETRY_CONFIGURATION_SCHEMA);
  });
```

Delete from `packages/telemetry/test/access-policy.test.ts`, in `describe('registration fails closed')`, the five tests whose value shape the schema now checks: `when the slot is empty`, `when the slot is not a string`, `when an 'AccessPolicy' slot has an empty permission entry`, `when an 'AccessPolicy' slot names an invalid permission`, `when telemetry.auth.domain is set but not a non-empty string`. Keep `when the slot is missing`, `names no registered BasePolicy`, `names TelemetryAccessPolicy itself`, `has no permission entry`, the development-skip case and the rest: they are the checks that stay in code.

Delete from `packages/telemetry/test/contributor.test.ts` the test `leaves malformed values to the route registration check`. The `emits every permission ...`, `checks in root when telemetry.auth.domain is unset` and boot (B02) tests stay: they run on the in-memory configuration, which is why `@Config` keeps `defaultValue`.

- [ ] **Step 3: RED**

Run: `cd packages/telemetry && npx ts-mocha -p tsconfig.json test/auth-config.test.ts test/bootstrappers.test.ts`.
Expected: the schema cases PASS (Step 1 exists). FAIL: both `TelemetryAccessContributor reads ...` tests (`contributor.contribute('tel').permissionRefs` is `[]`, because the class still reads the root Configuration, which has no `telemetry.auth`) and `TelemetryBootstrapper registers the telemetry configuration schema` (`expected [] to include ...`).

- [ ] **Step 4: Implement**

`packages/telemetry/src/bootstrap.ts`: `import { Configuration, registerConfigurationSchema } from '@spinajs/configuration';`, add `import { TELEMETRY_CONFIGURATION_SCHEMA } from './schema.js';` after the `Metrics` import, and begin `bootstrap()` with (the `await DI.resolve(Configuration)` that follows stays):

```ts
  public async bootstrap(): Promise<void> {
    registerConfigurationSchema(TELEMETRY_CONFIGURATION_SCHEMA);
    const cfg = await DI.resolve(Configuration);
```

`packages/telemetry/src/policies/TelemetryAccessPolicy.ts`:

1. Imports: replace `import { Configuration } from '@spinajs/configuration';` with `import { Config } from '@spinajs/configuration';`. `DI`, `isPermission`, `parsePermission` stay (DI lookups; the contributor).
2. In `TelemetryAccessPolicy`, add after the `Log` property:

```ts
  @Config('telemetry.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('telemetry.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('telemetry.auth.domain', { defaultValue: 'root' })
  protected Domain: string;
```

3. Replace `read()` (lines 71-103):

```ts
  protected read(): Guard {
    const endpoint = this.endpoint;
    const slotKey = `telemetry.auth.policies.${endpoint}`;
    const fail = (why: string) => new RouteRegistrationException(`telemetry endpoint ${String(endpoint)}: ${why}`);

    if (typeof endpoint !== 'string' || endpoint.length === 0) throw fail('the endpoint name must be a non-empty string');

    const slot = this.Policies[endpoint];
    if (slot === undefined) throw fail(`${slotKey} must name a policy, but it is not set`);

    if (slot === TELEMETRY_ACCESS_SLOT) {
      const permissionsKey = `telemetry.auth.permissions.${endpoint}`;
      const raw = this.Permissions[endpoint];
      if (raw === undefined) throw fail(`${permissionsKey} must be a permission name or a non-empty list of them, but it is not set`);
      const permissions = (typeof raw === 'string' ? [raw] : raw) as Permission[];

      if (telemetrySkipsAuth()) {
        this.Log.warn(`telemetry endpoint ${endpoint}: authorization skipped (telemetry.auth.skipInDevelopment in a development env)`);
        return { kind: 'skip' };
      }
      return { kind: 'access', policy: new AccessPolicy('route'), holder: ruleHolder(permissions, this.Domain) };
    }

    if (slot === TelemetryAccessPolicy.name) throw fail(`${slotKey} must not name TelemetryAccessPolicy itself`);
    const type = DI.checkType(BasePolicy, slot) ? (DI.getRegisteredTypes(BasePolicy) ?? []).find((t): t is Class<BasePolicy> => !isFactory(t) && t.name === slot) : undefined;
    if (!type) throw fail(`${slotKey} names ${slot}, which is not a registered BasePolicy`);

    const policy = DI.resolve(type);
    if (!(policy instanceof BasePolicy)) throw fail(`${slotKey} names ${slot}, which does not resolve synchronously to a BasePolicy`);
    return { kind: 'named', policy };
  }
```

4. Delete `const isRecord = ...` (line 116) and replace `TelemetryAccessContributor` with (keep its doc comment, dropping its last sentence about malformed values, which the schema now rejects at boot):

```ts
@Injectable(AuthzContributor)
export class TelemetryAccessContributor extends AuthzContributor {
  @Config('telemetry.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('telemetry.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('telemetry.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  public contribute(domain: string): AuthzContribution {
    const permissionRefs: PermissionRefDecl[] = [];
    if (this.Domain !== domain) return { permissionRefs };

    for (const [endpoint, slot] of Object.entries(this.Policies)) {
      if (slot !== TELEMETRY_ACCESS_SLOT) continue;
      const raw = this.Permissions[endpoint];
      const source = `telemetry.auth.permissions.${endpoint}`;
      for (const permission of typeof raw === 'string' ? [raw] : raw ?? []) {
        if (isPermission(permission)) permissionRefs.push({ permission, type: parsePermission(permission).resource, source });
      }
    }
    return { permissionRefs };
  }
}
```

- [ ] **Step 5: GREEN, package suite, dependants**

Run, sequentially: `npx ts-mocha -p tsconfig.json test/auth-config.test.ts test/bootstrappers.test.ts test/access-policy.test.ts test/contributor.test.ts test/policy-registration.test.ts` in `packages/telemetry`, then `npm test` in `packages/telemetry`; rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) and run `npm test` in `packages/telemetry-otel` if its `package.json` lists `@spinajs/telemetry`.
Expected: all pass. Note `src/config/telemetry.ts` is unchanged and still valid under the schema (test `accepts the shipped telemetry configuration`).

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/src packages/telemetry/test/support/child-config.ts packages/telemetry/test/auth-config.test.ts packages/telemetry/test/bootstrappers.test.ts packages/telemetry/test/access-policy.test.ts packages/telemetry/test/contributor.test.ts
git commit -m "refactor(telemetry): telemetry.auth through @Config and a registered schema, no hand validation"
```

Commit body: `telemetry.auth.skipInDevelopment: 'true'` is now coerced to `true` at boot (the old check was exact); `telemetrySkipsAuth` is unchanged.

---

### Task 6.5: http-socket `http.socket` limits through a schema; `assertLimitsConfig`, `assertHooksConfig`, `assertOrderingConfig` deleted

Inventory row: http-socket `assertLimitsConfig` (and its two siblings, ~48 LOC). The `http` middlewares part of the row (`RealIp`, `CorsMiddleware`, `ThrottleMiddleware`) belongs to Phase 3 and is not planned.

**Files:**
- Create: `packages/http-socket/src/schema.ts` (not under `src/config/`: files there are loaded as configuration)
- Modify: `packages/http-socket/src/index.ts` (add an export)
- Modify: `packages/http-socket/src/limits.ts` (line 2, line 4, delete lines 84-132)
- Modify: `packages/http-socket/src/dispatcher.ts` (line 12 import, lines 69-71)
- Create: `packages/http-socket/test/child-config.ts`, `packages/http-socket/test/config-schema.test.ts`
- Modify: `packages/http-socket/test/harness.ts` (imports, `configure`), `packages/http-socket/test/limits.test.ts` (lines 4, 99-155), `packages/http-socket/test/limits-pipeline.test.ts` (lines 12, 178-200), `packages/http-socket/test/ordering.test.ts` (line 10, lines 276-281), `packages/http-socket/test/exports.test.ts` (the `PUBLIC_API` list)

**Interfaces:**
- Consumes: `registerConfigurationSchema`, `InvalidConfiguration`; `$data` (Phase 0).
- Produces: `SOCKET_CONFIGURATION_SCHEMA`, `SocketConfigBootstrapper`. `SocketDispatcher`, `SocketServer` and `SocketHub` already use `@Config('http.socket')`; they change only by losing the three `assert*Config` calls.

Stays in code: nothing from these three functions. A schema expresses all of them: positive numbers (`exclusiveMinimum`), integers, the rule `maxInFlightEventsPerConnection >= rate.burst` (`minimum: { $data: '1/rate/burst' }`), the transport enum, finite numbers (Ajv's `number` rejects `NaN` and `Infinity`). The shipped `src/config/http-socket.ts` stays the source of the default values: the old code hand-coded none, so the schema adds `required` (fail closed on a missing block, as the old destructuring did) and no `default` keywords. `adapter` (a constructor function) and the keys the asserts never checked stay unvalidated on purpose.

- [ ] **Step 1: Schema additions**

Create `packages/http-socket/src/schema.ts`:

```ts
const positive = { type: 'number', exclusiveMinimum: 0 };
const positiveInteger = { type: 'integer', exclusiveMinimum: 0 };

export const SOCKET_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/http-socket.configuration.schema.json',
  $configurationModule: 'http.socket',
  description: 'Socket server configuration (http.socket.*)',
  type: 'object',
  required: ['rate', 'maxPayloadBytes', 'maxInFlightPerConnection', 'maxInFlightEventsPerConnection', 'auth', 'hooks', 'ordering'],
  properties: {
    rate: { type: 'object', required: ['perSecond', 'burst'], properties: { perSecond: positive, burst: positive } },
    maxPayloadBytes: positiveInteger,
    maxInFlightPerConnection: positiveInteger,
    // a cap below the burst would drop events the rate limit lets through
    maxInFlightEventsPerConnection: { ...positiveInteger, minimum: { $data: '1/rate/burst' } },
    auth: { type: 'object', required: ['revalidateMs'], properties: { revalidateMs: { type: 'number', minimum: 0 } } },
    // absent leaves socket.io's default
    transports: { type: 'array', minItems: 1, items: { type: 'string', enum: ['websocket', 'polling'] } },
    hooks: { type: 'object', required: ['connectTimeoutMs'], properties: { connectTimeoutMs: positive } },
    ordering: { type: 'object', required: ['abortGraceMs'], properties: { abortGraceMs: positive } },
  },
};
```

- [ ] **Step 2: Write the failing tests**

Create `packages/http-socket/test/child-config.ts` (the shared helper). Create `packages/http-socket/test/config-schema.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import _ from 'lodash';

import socketConfig from '../src/config/http-socket.js';
import { SOCKET_CONFIGURATION_SCHEMA, SocketConfigBootstrapper } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './child-config.js';

const socket = (patch: Record<string, unknown> = {}) => ({ http: { socket: { ..._.cloneDeep(socketConfig.http.socket), ...patch } } });

describe('http.socket configuration schema', () => {
  afterEach(disposeChildren);

  it('accepts the shipped configuration', async () => {
    await bootChild(socket(), SOCKET_CONFIGURATION_SCHEMA);
  });

  it('accepts the bounds: an event cap equal to the burst, a zero revalidation interval, one transport', async () => {
    await bootChild(socket({ rate: { perSecond: 50, burst: 100 }, maxInFlightEventsPerConnection: 100, auth: { required: false, revalidateMs: 0 }, transports: ['polling'] }), SOCKET_CONFIGURATION_SCHEMA);
  });

  describe('a bad value fails the boot with the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a zero rate', { rate: { perSecond: 0, burst: 100 } }, 'http.socket.rate.perSecond'],
      ['a negative rate', { rate: { perSecond: -1, burst: 100 } }, 'http.socket.rate.perSecond'],
      ['a zero burst', { rate: { perSecond: 10, burst: 0 } }, 'http.socket.rate.burst'],
      ['an event cap below the burst', { maxInFlightEventsPerConnection: 99 }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a fractional event cap', { maxInFlightEventsPerConnection: 128.5 }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a zero event cap', { rate: { perSecond: 50, burst: 1 }, maxInFlightEventsPerConnection: 0 }, 'http.socket.maxInFlightEventsPerConnection'],
      ['a fractional payload limit', { maxPayloadBytes: 1.5 }, 'http.socket.maxPayloadBytes'],
      ['a zero payload limit', { maxPayloadBytes: 0 }, 'http.socket.maxPayloadBytes'],
      ['a fractional command cap', { maxInFlightPerConnection: 1.5 }, 'http.socket.maxInFlightPerConnection'],
      ['a zero command cap', { maxInFlightPerConnection: 0 }, 'http.socket.maxInFlightPerConnection'],
      ['a negative revalidation interval', { auth: { required: false, revalidateMs: -1 } }, 'http.socket.auth.revalidateMs'],
      ['an empty transport list', { transports: [] }, 'http.socket.transports'],
      ['an unknown transport', { transports: ['websocket', 'flash'] }, 'http.socket.transports.1'],
      ['a transport list that is not a list', { transports: {} }, 'http.socket.transports'],
      ['a zero connect hook timeout', { hooks: { connectTimeoutMs: 0 } }, 'http.socket.hooks.connectTimeoutMs'],
      ['a zero abort grace', { ordering: { abortGraceMs: 0 } }, 'http.socket.ordering.abortGraceMs'],
      ['a missing hooks block', { hooks: undefined }, 'http.socket.hooks'],
      ['a missing ordering block', { ordering: undefined }, 'http.socket.ordering'],
      ['a missing revalidation interval', { auth: { required: false } }, 'http.socket.auth.revalidateMs'],
    ];

    for (const [label, patch, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(socket(patch), SOCKET_CONFIGURATION_SCHEMA)).to.include(path);
      });
    }
  });

  it('SocketConfigBootstrapper registers the schema', () => {
    new SocketConfigBootstrapper().bootstrap();

    expect(DI.RootContainer.Cache.get('__configurationSchema__', false) ?? []).to.include(SOCKET_CONFIGURATION_SCHEMA);
  });
});
```

In `packages/http-socket/test/harness.ts`: add `registerConfigurationSchema` to the `@spinajs/configuration` import (`import { Configuration, FrameworkConfiguration, registerConfigurationSchema } from '@spinajs/configuration';`), add `import { SOCKET_CONFIGURATION_SCHEMA } from '../src/schema.js';` after the `SocketServer` import, and in `configure()`:

```ts
export async function configure(cfg: Record<string, unknown> = {}): Promise<void> {
  overrides = cfg;
  DI.clearCache();
  DI.register(TestConfiguration).as(Configuration);
  registerConfigurationSchema(SOCKET_CONFIGURATION_SCHEMA);
  await DI.resolve(Configuration);
}
```

(`DI.clearCache()` drops the registered schema, so the harness registers it after each clear, as the bootstrapper does in an app. Order matters: the Configuration class is registered before the schema.)

In `packages/http-socket/test/limits.test.ts`: change line 4 to `import { TokenBucket, assertPayloadSize, assertRate, payloadSize } from '../src/limits.js';` and delete `describe('assertHooksConfig', ...)` and `describe('assertLimitsConfig', ...)` (lines 99-155); the schema cases above replace them.

In `packages/http-socket/test/ordering.test.ts`: delete the import on line 10 and the test `refuses a non-positive abort grace at startup` (lines 276-281).

In `packages/http-socket/test/limits-pipeline.test.ts`: replace the import on line 12 with `import { InvalidConfiguration } from '@spinajs/configuration';` and replace `describe('limit configuration', ...)` (lines 178-200) with:

```ts
  describe('limit configuration', () => {
    it('aborts server startup on a non-positive rate', async () => {
      let failure: unknown;
      try {
        t = await startServer({ http: { socket: { rate: { perSecond: 0, burst: 5 } } } });
      } catch (e) {
        failure = e;
      }
      expect(failure).to.be.instanceOf(InvalidConfiguration);
      expect((failure as InvalidConfiguration).violations.map((v) => v.path)).to.include('http.socket.rate.perSecond');
    });
  });
```

In `packages/http-socket/test/exports.test.ts`, add `'SOCKET_CONFIGURATION_SCHEMA',` to `PUBLIC_API` immediately before `'SOCKET_CONTROLLER_DESCRIPTOR',`, and `'SocketConfigBootstrapper',` between `'SocketCommandStage',` and `'SocketConnection',` (the list is sorted by code unit order). The `keeps internal helpers out of the public surface` test keeps listing the three `assert*Config` names; it stays true.

- [ ] **Step 3: RED**

Run: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/config-schema.test.ts`.
Expected: compile error `TS2305: Module '../src/index.js' has no exported member 'SOCKET_CONFIGURATION_SCHEMA'` (and `SocketConfigBootstrapper`): the schema exists only as a file until Step 4 exports it and adds the bootstrapper. A schema-first task has no other RED: once the exports exist, the schema cases pass; the deletion in Step 4 is guarded by the unchanged pipeline and dispatcher suites.

- [ ] **Step 4: Implement**

Put these imports at the top of `packages/http-socket/src/schema.ts`, above the constants:

```ts
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';
```

and append at the end of the file:

```ts
@Injectable(Bootstrapper)
export class SocketConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(SOCKET_CONFIGURATION_SCHEMA);
  }
}
```

In `packages/http-socket/src/index.ts` add `export * from './schema.js';` (after the `./metrics.js` export).

`packages/http-socket/src/limits.ts`: line 2 becomes `import type { IConnectionRuntime } from './interfaces.js';`; delete line 4 (`const TRANSPORTS ...`) and the three functions `assertLimitsConfig`, `assertHooksConfig`, `assertOrderingConfig` (lines 84-132, up to the blank line before `withSlot`'s doc comment).

`packages/http-socket/src/dispatcher.ts`: line 12 becomes `import { TokenBucket, assertPayloadSize, assertRate, untilAborted, withSlot } from './limits.js';` and in `resolve()` delete the three calls `assertLimitsConfig(this.Options);`, `assertOrderingConfig(this.Options);`, `assertHooksConfig(this.Options);` so it reads:

```ts
  public async resolve(): Promise<void> {
    await super.resolve();
    const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
    this.Stages = [...stages].sort((a, b) => a.Order - b.Order);
  }
```

- [ ] **Step 5: GREEN, package suite, dependants**

Run, sequentially: `npx ts-mocha -p tsconfig.json test/config-schema.test.ts test/exports.test.ts test/limits.test.ts test/limits-pipeline.test.ts test/ordering.test.ts` in `packages/http-socket`, then `npm test` (it also runs the `.mocharc.authz.json` suite); rebuild (`npx tsc -b tsconfig.mjs.json && npx tsc -b tsconfig.cjs.json`) and run `npm test` in `packages/http-socket-client` if its tests boot a `SocketServer`.
Expected: all pass. If a suite fails at `configure()` with `InvalidConfiguration`, its override breaks a rule the old `assert*Config` also enforced at dispatcher resolve; fix the override, not the schema.

- [ ] **Step 6: Commit**

```bash
git add packages/http-socket/src packages/http-socket/test
git commit -m "refactor(http-socket): http.socket limits through a registered schema, no assert*Config"
```

Commit body: a bad value now fails the Configuration boot with `InvalidConfiguration` (was `RangeError` when the dispatcher resolved); a numeric string such as `'1024'` is coerced by Ajv where the old check refused it.

---

## Rows not planned

| Row | Reason |
|---|---|
| users-http `roleDefinitions` (`authz.rbac.roles`) | Nothing to migrate. It is a plain function (`@Config` cannot apply) with no hand validation: it takes the `RoleStore` when registered and otherwise reads `authz.rbac.roles` with a `{}` default. The shape of `authz.rbac.roles` is already validated by `AUTHZ_RBAC_CONFIGURATION_SCHEMA` (and Phase 5 replaces `ConfigRoleStore`'s helpers). No change. |
| http `RealIp`, `CorsMiddleware`, `ThrottleMiddleware` (and `parseTrustProxy`, origin list checks) | Belong to Phase 3 (the `http` schema in `packages/http`), as instructed. |
| users-http `DefaultAccountGuard` (`authz.admin.guard`) | Planned in Phase 5, as instructed. |
| Deprecated 2.x paths (`rbac.roleSwitch.requirePassword`, `rbac.*`) | Out of scope: `@Config` reads the 2.x key in Task 6.2, but its list check stays in code until R1 deletes the path. |

## Self-review notes

- Every deleted hand check maps to a schema rule or a named stays-in-code reason: target-guard string and list checks (6.1), role-switch list check (6.2), defaultRoles trim and type (6.3), telemetry slot, permission and domain shape (6.4), the three `assert*Config` (6.5).
- Behaviour changes to record in commit bodies: `InvalidConfiguration` at boot instead of `AuthzConfigError`/`RangeError` at first use; Ajv coercion is looser than the old checks (6.1, 6.4, 6.5); padded default role names fail instead of being trimmed (6.3); `requirePassword: null` stays valid (6.2).
- Risk points: (a) 6.1 and 6.2 add defaults to `AUTHZ_CONFIGURATION_SCHEMA`, so an app without users now has `authz.impersonation` populated; harmless, nothing else reads it. (b) 6.5 depends on the Phase 3 `http` schema root staying open. (c) The `defaultValue` duplication (Decision 2) is pinned by the 6.1 defaults test and by the telemetry `gives an unconfigured app the code defaults` test; add the same equality check to any later task that copies the pattern.
