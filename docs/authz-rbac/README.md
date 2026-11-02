# `@spinajs/authz-rbac`

The RBAC model of SpinaJS authorization: roles with grants, assignments of roles to subjects at scopes, their stores, the `AuthzAdmin` write handlers, the admin guard and the database backend of `AuthzAdmin`.

Importing it registers `RbacModel` under `AuthorizationModel`, but activates nothing: a domain checks with RBAC once its `models` list names `'RbacModel'` (see [Wiring the model](#wiring-the-model)). It does not decide alone either: the engine of [`@spinajs/authz`](../authz/README.md) combines its vote with the other models of the domain.

## Install

```sh
npm install @spinajs/authz-rbac
```

## The model in one page

| Term | Meaning | Where it lives |
| --- | --- | --- |
| Permission | A name `resource:action`, such as `invoice:approve`. Declared in `authz.permissions` (core). | config |
| Role | A name with grants, such as `accountant`. Inherits other roles through `extends`. | `authz.rbac.roles` (`ConfigRoleStore`) |
| Grant | One permission (or glob) a role gives, optionally narrowed by a relation, resource patterns, fields, a tag or a scope type. | inside a role |
| Subject | Who holds a role: a principal (`user:42`), a wildcard (`user:*`) or a subject set (`team:7#team.member`, every holder of a role at a scope). | assignment row |
| Scope | Where an assignment applies: `$global`, or one resource and everything below it. | assignment row |
| Assignment | subject × role × scope, with optional tags and expiry. | `authz_assignment` (`DbAssignmentStore`) |

A principal's permissions are the union of the grants of all its live assignments on the path of the checked resource. A deny role subtracts permissions and beats every permit. Rules (`restrict`, `cap`, `threshold`) only narrow.

Start with [Roles and permissions](03-roles-and-permissions.md), then [Assigning roles](04-assigning-roles.md) and [How a check resolves](05-check-resolution.md).

## Features

| Feature | What it does |
| --- | --- |
| [List filter term (`rbac.assignment`)](01-list-filter-term.md) | Turns the RBAC part of an access plan into ORM conditions over `authz_assignment` for `.accessible()` lists. |
| [Database storage](02-database-storage.md) | DB stores and `DbAuthzAdminBackend` on ORM records over the `authz` connection alias, with their tables and migrations. |
| [Roles and permissions](03-roles-and-permissions.md) | Define roles and grants in `authz.rbac.roles`: inheritance, relations, resource patterns, fields, deny roles, `scopeTypes`. |
| [Assigning roles](04-assigning-roles.md) | Grant, change and revoke roles for users, wildcards, teams and groups, through `AuthzAdmin`, config, the CLI or HTTP. |
| [How a check resolves](05-check-resolution.md) | How `RbacModel` wires a domain, its gather and nine steps, the role and assignment caches, `RbacService`. |
| [Ladders, tags and implied roles](06-ladders-tags-and-implied-roles.md) | Ranked roles, `requiresTag`, `grantedAt` and `implies`. |
| [Rules](07-rules.md) | `restrict`, `cap` and `threshold` rules from config (`ConfigRuleStore`) or the database (`DbRuleStore`). |
| [Share links](08-share-links.md) | `link.create` tokens, the `link` principal and its ceiling, `RbacLinkResolver`. |
| [Admin guard](09-admin-guard.md) | `DefaultAdminGuard`: escalation, self-lockout, last holder and protected roles; `RbacAdminFacts`, `AccountStatusSource`. |
| [Token roles](10-token-roles.md) | `authz.token.excludedRoles` and the `TokenRolePolicy` that narrow the roles of token principals. |
| [Custom stores](11-custom-stores.md) | The store ports, `registerRbacStores`, the memory stores and how to plug in your own. |
| [Model extensions](12-model-extensions.md) | `RbacExtension`: hooks into the model's init, compile and gathering phase. |
| [CLI commands](13-cli-commands.md) | `authz:assign`, `authz:revoke`, `authz:explain`, `authz:check-config`, `authz:membership-verify`, `authz:membership-rebuild`. |

## Quick start

1. Declare the permission and a role that grants it:

   ```ts
   // config/authz.ts
   export default {
     authz: {
       permissions: { 'invoice:read': {}, 'invoice:approve': {} },   // types default to ['invoice']
       rbac: { roles: { accountant: { scopeTypes: ['org'], grants: ['invoice:read', 'invoice:approve'] } } },
       admin: { backend: 'DbAuthzAdminBackend' },
     },
   };
   ```

2. Wire the model at boot (next section) and run the migrations of [Database storage](02-database-storage.md#migrations).
3. Assign the role, and check:

   ```ts
   await authz().admin().assign(actor, { subject: { type: 'user', id: '42' }, role: 'accountant', scope: { type: 'org', id: '7' } });
   await authz().assert(user42, 'invoice:approve', { type: 'invoice', id: '1001' });   // allowed when invoice 1001 lies under org 7
   ```

## Wiring the model

Importing the package registers `RbacModel` under `AuthorizationModel`. Name it in the `models` list of the domain that should check with it:

```ts
authz: { models: ['RbacModel'] }   // root; another domain: authz.domains.<name>.models
```

`RbacModel` is `@PerChildInstance()`, so DI builds one instance per domain that lists it ([Models by name](../authz/05-domains.md#models-by-name)). Its `init(ctx)` wires that domain's container:

1. Counts the stores `authz.rbac.stores.*` names: exactly one `roles` and one `assignments` store, at most one `links` and one `membership` store, at most one in-memory and one other `rules` store. It refuses `authz.rbac.rules` when no `ConfigRuleStore` is named.
2. Calls `registerRbacStores`, which registers each named class under its port ([Custom stores](11-custom-stores.md)).
3. Builds the extensions over the stores.
4. Registers `RbacContributor` as `AuthzContributor`, an `RbacService`, and an `RbacLinkResolver` over that service as `LinkResolver`, which share-link principals read.

Every refusal throws `AuthzConfigError` before anything is registered. authz-http reads the `LinkResolver` from the root container, so share links need `'RbacModel'` in `authz.models`; listed only in a child domain, links are dead.

### Options of the DI-built model

- The RBAC clock is the domain's `AuthzClock`, so a test that moves `ManualClock` moves the assignment cache TTL too.
- `extensions`, `log`, `clock` and `service.ancestors` are code, not config. Register an `RbacOptions` subclass in the domain's container (or root) to pass them:

```ts sample
import { Injectable } from '@spinajs/di';
import { RbacOptions, createRbacExtensions } from '@spinajs/authz-rbac';
import type { RegisterRbacOptions } from '@spinajs/authz-rbac';

@Injectable(RbacOptions)
export class AppRbacOptions extends RbacOptions {
  options(): RegisterRbacOptions {
    // The default extensions; append your own here.
    return { extensions: (o) => [...createRbacExtensions(o)] };
  }
}
```

A custom `subjects` resolver is only available by building the model yourself.

### Wiring by hand

`new RbacModel(options)` builds a model over the stores in `options` and wires nothing: the caller registers the contributor and the service. `rbacStoreOptions` and `registerRbacServices` do the two halves of what `init` does. Run them in the container of the domain, at boot, after `Configuration` and before the domain's `AuthzService` first resolves, then register the model as a named factory and list that name:

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthorizationModel } from '@spinajs/authz';
import { RbacModel, rbacStoreOptions, registerRbacServices } from '@spinajs/authz-rbac';

// Config: authz: { models: ['AppRbacModel'] }
export async function setupRbacByHand(): Promise<void> {
  const configuration = await DI.resolve(Configuration);
  const model = new RbacModel(await rbacStoreOptions(DI.RootContainer, configuration));
  // Registers RbacContributor, RbacService and the LinkResolver in the root domain.
  registerRbacServices(DI.RootContainer, model);
  DI.register(Object.defineProperty(() => model, 'name', { value: 'AppRbacModel' })).as(AuthorizationModel);
}
```

- `rbacStoreOptions(container, configuration, opts?)` runs steps 1 and 2 above and returns the `RbacModelOptions` over the registered stores. Every refusal throws `AuthzConfigError` before anything is registered.
- `registerRbacServices(container, model, serviceOptions?)` runs step 4 and returns the `RbacService`.
- Do not list `'RbacModel'` in the same domain: both models are named `rbac`, and two models with the same name fail the boot.

| Option of `RegisterRbacOptions` | Effect |
| --- | --- |
| `extensions` | `(options) => RbacExtension[]`: replaces the default extensions ([Model extensions](12-model-extensions.md)). |
| `log` | The logger of the model; default the host log `authz-rbac`. |
| `clock` | `{ now(): Date }` that times the assignment cache and the role version check; for the DI-built model, default the domain's `AuthzClock`; given to `rbacStoreOptions`, default the system clock. |
| `service` | `RbacServiceOptions` without `links`: the `ancestors` function `RbacService.rolesOf` uses without a context. By hand, pass it to `registerRbacServices`. |

The ABAC model is wired the same way; see [`@spinajs/authz-abac`](../authz-abac/README.md).

## What importing the package registers

| Registered at import | Token |
| --- | --- |
| `RbacAssignmentHandler`, `RbacLinkHandler`, `RbacRuleHandler` | `AuthzWriteHandler` |
| `RbacAdminReader` | `AuthzAdminReader` |
| `RbacScopeForgetter` | `ScopeForgetter` |
| `RbacRuleListGuard` | `ListSupportGuard` |
| `DefaultAdminGuard` | `AdminGuard` |
| `CheckRbacAdminFacts` | `RbacAdminFacts` |
| `RbacChangeAudience` | `ChangeAudience` |
| `RbacAssignmentTerm` | `PlanTermCompiler` |
| `DbAuthzAdminBackend` | `AuthzAdminBackend` |
| `OwnRolesTokenRolePolicy` | `TokenRolePolicy` |
| `ConfigRoleStore`, `ConfigRuleStore`, `DbAssignmentStore`, `DbMembershipStore`, `DbRuleStore`, `DbLinkStore` | their class names only |
| The `authz.rbac`, `authz.token` and `authz.admin.guard` config schemas | configuration |

## Related packages

- [`@spinajs/authz`](../authz/README.md): the engine, permissions, `AuthzAdmin` and the domain host this model plugs into.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `.accessible()` lists, the ancestor table the check path reads, and the `owner` relation.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the policy model that votes next to RBAC and shares the `authz` connection alias.
- [`@spinajs/authz-http-admin`](../authz-http-admin/README.md): HTTP routes over `AuthzAdmin` that grant and revoke roles.
- [`@spinajs/authz-http`](../authz-http/README.md): `@Access`, principals, `LinkResolver` and `/user/access`.
- [`@spinajs/authz-convert`](../authz-convert/README.md): turns 2.x `rbac.*` grants and roles into `authz.rbac.roles` ([grant and role conversion](../authz-convert/04-grant-and-role-conversion.md)).
- [`@spinajs/users`](../users/README.md): the `self` relation, `authz.rbac.defaultRoles`, the role switch over `RbacService` and `UserAccountStatusSource`.
- [`@spinajs/teams`](../../packages/teams/README.md): teams and groups as subject sets (`team.member`, `group.member`) on the `team` ladder.
