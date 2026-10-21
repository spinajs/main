# `@spinajs/authz-rebac`

The ReBAC model of SpinaJS authorization: access follows relation tuples (`doc:d1#viewer@group:eng#member`) under namespaces whose permissions are rewrites, in the style of Google Zanzibar and Ory Keto. A folder's viewers read its docs, a group's members inherit what the group holds, an editor must also be approved, a banned user loses what the rest grants.

It does **not** register the model for you: the app builds a `RebacModel` and registers it next to RBAC or ABAC. The engine and `AuthzAdmin` live in [`@spinajs/authz`](../authz/README.md); this package adds the model, its tuple stores, its list term and its admin commands.

## Install

```sh
npm install @spinajs/authz-rebac
```

## Features

| Feature | What it does |
| --- | --- |
| [The ReBAC model](01-rebac-model.md) | `RebacModel`: wiring, how a check walks the tuples, depth and call limits, votes and freshness. |
| [Namespaces](02-namespaces.md) | `authz.rebac.namespaces`: relations, permissions as rewrites (computed, tuple-to-userset, union, intersection, exclusion), the permission map and the boot checks. |
| [Tuple stores](03-tuple-stores.md) | `TupleStore`, `MemoryTupleStore`, `DbTupleStore` and the `authz_rebac_tuple` table. |
| [Lists](04-lists.md) | Type-level residuals for `filter()`, SQL list plans for `.accessible()`, and why exclusion is not planned. |
| [Tuple administration](05-tuple-administration.md) | `tuple.write`, `tuple.delete`, the `tuples` query and `scope.forget` through `AuthzAdmin`, and the HTTP command schemas. |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { AuthorizationModel } from '@spinajs/authz';
import { DbTupleStore, RebacModel, TupleStore } from '@spinajs/authz-rebac';

// Namespaces and the permission map come from authz.rebac.*; tuples live in authz_rebac_tuple.
export function wireRebac(): void {
  const store = new DbTupleStore();
  const rebac = new RebacModel({ store });
  DI.register(() => rebac).as(AuthorizationModel);
  DI.register(() => store).as(TupleStore);
}
```

Then describe the namespaces in config:

```ts
authz: {
  rebac: {
    permissions: { 'doc:read': 'doc#view', 'folder:read': 'folder#view' },
    namespaces: {
      group: { relations: { member: ['user', 'group#member'] } },
      folder: {
        relations: { parent: ['folder'], viewer: ['user', 'group#member'] },
        permissions: { view: { union: ['viewer', 'parent->view'] } },
      },
      doc: {
        relations: { parent: ['folder'], owner: ['user'], viewer: ['user', 'group#member'] },
        permissions: { view: { union: ['owner', 'viewer', 'parent->view'] } },
      },
    },
  },
}
```

Write tuples through `AuthzAdmin` (`tuple.write`, [Tuple administration](05-tuple-administration.md)) or the store, and run the `AuthzRebac_2026_10_21_00_00_00` migration on the `authz` connection.

## Related packages

- [`@spinajs/authz`](../authz/README.md): the engine, the vote combination and `AuthzAdmin`.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `.accessible()` lists, which compile this model's `rebac.tuples` plan term.
- [`@spinajs/authz-http-admin`](../authz-http-admin/README.md): `POST /authz/commands`, which lists the tuple commands once `@spinajs/authz-rebac/http` is imported.
- [`@spinajs/authz-testing`](../authz-testing/README.md): `FakeTupleModel` for app tests, the model conformance suite and the B49 behaviour spec this package passes.
