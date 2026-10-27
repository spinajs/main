# `@spinajs/authz-abac`

The ABAC model of SpinaJS authorization: permit and deny policies that target permissions, types, principals, actors and scopes, and hold under a condition on principal, actor, resource, env and scope attributes. Policies come from config, memory or the database, and change at run time through `AuthzAdmin`.

Importing the package registers `AbacModel` under `AuthorizationModel`; a domain checks with it once its `models` list names `'AbacModel'`. The engine, the condition compiler and `AuthzAdmin` live in [`@spinajs/authz`](../authz/README.md); this package adds the model, its stores and its admin handlers.

## Install

```sh
npm install @spinajs/authz-abac
```

## Features

| Feature | What it does |
| --- | --- |
| [The ABAC model](01-abac-model.md) | `AbacModel`: wiring, how a check resolves under policies, the vote, reloads and summaries. |
| [Policies](02-policies.md) | The policy fields, how a policy targets a request, and how to add one with its permission. |
| [Conditions](03-conditions.md) | How `when` is evaluated: attribute paths, operators, UNKNOWN, functions and custom `ConditionFunction`s. |
| [Lists](04-lists.md) | List support at boot, list plans before the query, and the `policy.put` list guard. |
| [Policy stores](05-policy-stores.md) | `PolicyStore`, `ConfigPolicyStore`, `MemoryPolicyStore`, `authz.abac.*` config and custom stores. |
| [Database policy store](06-database-policy-store.md) | `DbPolicyStore` keeps policies written through `AuthzAdmin` in `authz_policy` on the `authz` connection alias. |
| [Policy administration](07-policy-administration.md) | `policy.put`, `policy.delete`, the `policies` query and `scope.forget` through `AuthzAdmin`. |

## Quick start

```ts
authz: { models: ['AbacModel'] }   // root; another domain: authz.domains.<name>.models
```

`AbacModel` is `@PerChildInstance()`, so DI builds one instance per domain that lists it, over `authz.abac.*`. Its `init` registers its `AbacContributor` in the domain's container ([Models by name](../authz/05-domains.md#models-by-name)). To pass `AbacModelOptions`, build the model by hand, register it as a named factory and list that name instead:

```ts sample
import { DI } from '@spinajs/di';
import { AuthorizationModel } from '@spinajs/authz';
import { AbacModel } from '@spinajs/authz-abac';

// Config: authz: { models: ['AppAbacModel'] }
// Policies from authz.abac.policies only (authz.abac.stores defaults to ['ConfigPolicyStore']).
export function registerAppAbac(): void {
  const abac = new AbacModel();
  // init registers the AbacContributor, whoever built the model.
  DI.register(Object.defineProperty(() => abac, 'name', { value: 'AppAbacModel' })).as(AuthorizationModel);
}
```

Then add policies to config:

```ts
authz: {
  abac: {
    policies: [
      { id: 'mfa-admin-writes', effect: 'deny', permissions: ['users:update', 'users:delete'],
        when: { not: { attr: 'principal.authn.assurance', eq: 'aal2' } }, reason: 'mfa_required' },
    ],
  },
}
```

To write policies through `AuthzAdmin`, add a `DbPolicyStore` and register it as `PolicyStore` ([Database policy store](06-database-policy-store.md#examples)).

## Related packages

- [`@spinajs/authz`](../authz/README.md): the engine, the vote combination, the condition compiler and `AuthzAdmin`.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the RBAC model ABAC votes combine with, and `DbAuthzAdminBackend`, which runs `AuthzAdmin` batches on the `authz` connection.
- [`@spinajs/authz-orm`](../authz-orm/README.md): ancestors for scoped policies, scope attributes for `scope.<type>.*`, `.accessible()` lists, and `scope.forget` on row deletes.
- [`@spinajs/authz-fs`](../authz-fs/README.md): builds an `AbacModel` named `fs-abac` for filesystem policies.
