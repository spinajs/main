# Holders

A holders query answers "who holds `permission` on `scope`?". It lists every subject with a live role
assignment on the resource, on an ancestor or on `$global`, where the role grants the permission. Use
it for admin screens such as "who can read this document".

```ts
admin.list(actor, { kind: 'holders', scope, permission, expandSets?, page? })
```

## How it works

1. `AuthzAdmin.list` checks that the actor holds `authz:holders.read` at `scope`. An unknown resource
   answers `forbidden`, because this check runs first.
2. `RbacAdminReader` calls `listHolders`. It throws `AuthzConfigError` when the domain has no
   `RbacModel`, or its `AuthzService` lacks `ancestors()` or `inspect()`.
3. It fails with `invalid_query` when the permission is unknown, or not checkable on the type of
   `scope`.
4. `AuthzService.ancestors(scope)` returns the path a check walks: `[scope, ...ancestors, $global]`.
5. `grantingRoles` finds the roles that grant the permission: through `extends`, ladders, permission
   `implies` and role `implies`.
6. For each scope of the path, the `AssignmentStore` returns the live assignments. Each assignment of
   a granting role adds a `via` entry to its subject.
7. With `expandSets: true`, each subject set is expanded with `MembershipStore.membersOf` (the
   transitive closure). Every member gets the set's `via` entries, plus `set`.
8. Holders are sorted by subject key and paged. The page limit is capped at 500.
9. Each principal on the page gets a `decision` from `authz().inspect()`.

## Query and result

| Field | Type | Meaning |
| --- | --- | --- |
| `scope` | `ResourceRef` | The resource to inspect. |
| `permission` | `Permission` | The permission whose holders are listed. |
| `expandSets` | `boolean` | List members of subject sets. Needs a `MembershipStore`, else `invalid_query`. |
| `page` | `{ limit, offset }` | Page of the sorted list. |

`list` answers `{ items, total }`. Each item is a holder:

| Field | Meaning |
| --- | --- |
| `subject` | A principal, a subject set or a wildcard subject. |
| `via` | The assignments it holds the permission through: `role`, `scope`, `assignment` (id) and `set` when held as a set member. |
| `decision` | `{ allowed, conditional, reason? }` from `inspect()`. Absent for sets and wildcard subjects. |

## inspect

`AuthzService.inspect(input)` is an optional method. It returns a `Decision` for introspection, not an
access attempt:

- It is never audited.
- It reads and stores no decision cache, and models read fresh.
- It is meant for admin tools. Use `check` for real access decisions.

The holders query builds the principal from its ref alone, with no session attributes or ceiling. A deny
that rests on session facts (MFA, time, IP) therefore shows as denied.

`AuthzService.ancestors(ref)` is also optional. It returns the path a check walks, or `null` for an
unknown resource.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.admin.permissions` | object | `authz:*` | permission names | Maps admin operations to your own permissions. The actor needs `authz:holders.read` at the resource unless you map it. |

## HTTP

`GET /authz/holders?scope=doc:d1&permission=doc:read&expandSets=true&limit=&offset=` in
[`@spinajs/authz-http-admin`](../../packages/authz-http-admin/README.md). It answers 400
`invalid_query`, 401 or 403 `forbidden`.

## Important behaviour

- Not listed: config roles (`anonymousRoles`, `serviceRoles`), `owner`, `self` and column relations,
  and ABAC permits.
- `decision.conditional` is `true` when the check is allowed with a residual condition.
- `decision` agrees with enforcement for the principal's ref. It does not know the live session.
- A deny role does not remove a holder from the list. Read `decision` to see the effect.
- A subject that holds the permission through several assignments appears once, with several `via`
  entries.
- Members of nested sets are listed directly, with the set they came from in `via.set`.

## Patterns and antipatterns

```ts
// Don't: use inspect() to guard a user action. It is unaudited and skips the cache.
const d = await authz().inspect!({ principal: me, permission: 'doc:read', resource });

// Do: use check() or can() for access decisions, inspect() only in admin tools.
const allowed = await authz().can(me, 'doc:read', resource);
```

## Examples

### Who can read a document

```ts sample
import { authz } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';

export async function whoCanRead(actor: Principal, docId: string) {
  const { items, total } = await authz().admin().list(actor, {
    kind: 'holders',
    scope: { type: 'doc', id: docId },
    permission: 'doc:read',
    expandSets: true,
    page: { limit: 50, offset: 0 },
  });
  return { total, holders: items };
}
```

## Related

- [AuthzAdmin](./README.md#authzadmin): the admin API and its permissions.
- [Column relations](./02-column-relations.md): relation grants, which holders does not list.
- [Fresh checks](./01-fresh-checks.md): a sibling feature page.
