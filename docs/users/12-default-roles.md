# Default roles

`authz.rbac.defaultRoles` lists the roles `create()` grants a new user when the caller names none. `DefaultRolesBootCheck` validates that list when the root authz domain boots, so a typo fails the start, not the first sign-up.

## How it works

1. `create(data, roles?)` normalizes `roles` with `roleList()`. A non-empty result is used as is.
2. Otherwise it reads `authz.rbac.defaultRoles`. A value that is not an array (set at runtime past the schema) counts as no roles; an array is de-duplicated.
3. The roles are dry-run, then granted at GLOBAL to `user:<Uuid>` through `AuthzAdmin` (see [User actions](03-user-actions.md#createdata-roles-actor--system)).

At boot:

1. The authz host asks every `AuthzContributor` during each domain boot, after the models initialised. `DefaultRolesBootCheck.contribute(domain)` acts only for `'root'` and contributes nothing.
2. With an empty list it does nothing.
3. Without a registered `RoleStore` it throws `AuthzConfigError: authz.rbac.defaultRoles names roles, but no RoleStore is registered to define them`.
4. It loads every `RoleStore` of the root container (`Array.chainOf(RoleStore)`), compiles the roles and ladders the way the RBAC model does, and asks `assignmentProblem(graph, role, GLOBAL)` for each default role.
5. A role that is undefined, not assignable, or not allowed at GLOBAL throws `AuthzConfigError: authz.rbac.defaultRoles: role '<role>' cannot be given to new users (<problem>)`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.defaultRoles` | `string[]` | unset: no roles | assignable roles defined in a `RoleStore`, allowed at GLOBAL | Roles of a user created without explicit roles. |

users ships no `defaultRoles` (or `anonymousRoles`): config arrays are concatenated on merge, so a shipped list could not be removed by the application.

```ts
// config/authz.ts in your app
export default {
  authz: {
    rbac: {
      defaultRoles: ['user'],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Default roles boot check | `AuthzContributor` list (`Array.chainOf`), singleton, `@Injectable(AuthzContributor)` on import | `DefaultRolesBootCheck` | none | `DI.unregister(DefaultRolesBootCheck)` to skip it (the first `create()` then reports a bad role). |
| Your boot checks | `AuthzContributor` list | | any number | `@Injectable(AuthzContributor)`; return `{}` to contribute nothing, throw `AuthzConfigError` to fail the boot. |
| Role source | `RoleStore` list (`@spinajs/authz-rbac`) | authz-rbac's config role store | your store | Register a `RoleStore`; the check reads every one in the root container. |

### Custom boot check: require a support role for help-desk accounts

A contributor that fails the root boot when a role your code grants by name is missing.

```ts sample
import { Injectable, DI } from '@spinajs/di';
import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { RoleStore } from '@spinajs/authz-rbac';

const REQUIRED_ROLES = ['support'];

@Injectable(AuthzContributor)
export class RequiredRolesBootCheck extends AuthzContributor {
  public async contribute(domain: string): Promise<AuthzContribution> {
    if (domain !== 'root') {
      return {};
    }

    const defined = new Set<string>();
    for (const store of (await DI.RootContainer.resolve(Array.chainOf(RoleStore))) as RoleStore[]) {
      for (const role of (await store.load()).roles) {
        defined.add(role.name);
      }
    }

    const missing = REQUIRED_ROLES.filter((r) => !defined.has(r));
    if (missing.length > 0) {
      throw new AuthzConfigError(`help desk: roles ${missing.join(', ')} are not defined`);
    }

    return {};
  }
}
```

## Important behaviour

- The check runs for the root domain only. A child domain's own RBAC is not checked against `defaultRoles`.
- An explicit role list in `create()` replaces the defaults; they are not merged.
- `Configuration.set('authz.rbac.defaultRoles', 'user')` at runtime (a string, not a list) grants no roles rather than the roles `u`, `s`, `e`, `r`.
- `rbac:user-create` without `--roles` uses the defaults too.

## Best practices

- Set `defaultRoles` to the least privileged role (`['user']`), and grant more through `AuthzAdmin` after review.
- Keep `admin.users` and `admin` out of the defaults; `admin.users` is not assignable and fails the boot check.

## Patterns and antipatterns

```ts
// Don't: decide per caller by editing the shared default at runtime; concurrent creates race
config.set('authz.rbac.defaultRoles', ['partner']);
await create(data);

// Do: pass the roles to this create
await create(data, ['partner'], actor);
```

## Related

- [User actions](03-user-actions.md): `create()` and its role grants.
- [Authz resources and relations](11-authz-resources-and-relations.md): the roles users ships.
- [`@spinajs/authz`](../authz/README.md): `AuthzContributor`, `AuthzAdmin` and RBAC configuration.
