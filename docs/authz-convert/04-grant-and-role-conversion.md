# Grant and role conversion

`convertGrants()` turns the 2.x `accesscontrol` grants (`rbac.grants`) and declared roles (`rbac.roles`) into 3.0 role definitions under `authz.rbac.roles`, and registers every permission they use under `authz.permissions`. It writes what 2.x granted, one action at a time, and refuses what it cannot write without changing who gets access.

## How it works

1. For each role in `rbac.grants`, in 2.x key order, it checks the role name. `*`, `!`, `$`, `$extend` and blank names are refused. A name that is not a valid 3.0 role name is written as is, with a manual `role-name` item: renaming it would orphan the stored assignments.
2. `$extend` becomes `extends`, without duplicates. A role extending itself is refused.
3. For each resource, it checks the name against `[A-Za-z][A-Za-z0-9_.-]*` and the 3.0 permission rules of `@spinajs/authz`. `user:impersonate` is the one exception (see [Impersonation](#impersonation)).
4. `readActions()` splits the action keys. Only `create`, `read`, `update` and `delete`, then `:own` or `:any`, are converted. Other keys are refused, or listed as `action-never-read` where 2.x accepted them but never looked them up (`read`, `read:`, `read:own:x`).
5. `readAttributes()` reads each attribute list into `scope:` tokens and field globs. A list with no attribute that does not start with `!` granted nothing in 2.x and is skipped (`grants-nothing` note).
6. `verbGrants()` builds one 3.0 grant per verb from the `:any` and `:own` lists (rules below).
7. Each grant's permission `<resource>:<verb>` is added to `authz.permissions`, with `fields: true` when some grant on it carries fields, else `{}`.
8. `rbac.roles` entries are merged in: a description goes to the role, a declared role without grants is written with `grants: []`.

## Grant rules

| 2.x | 3.0 grant | Notes |
| --- | --- | --- |
| `X: { 'read:any': ['*'] }` | `'X:read'` | A plain string when there is no relation and no field list. |
| `X: { 'read:own': ['*'] }` | `{ permission: 'X:read', relation: 'owner' }` | `self` instead of `owner` for resources in `--self-resources`. |
| `X: { 'read:own': ['scope:partner'] }` | `{ permission: 'X:read', relation: 'partner' }` | Several tokens give an array of relations. `scope:default` means `owner` (or `self`). |
| `X: { 'read:any': ['*', '!Password'] }` | `{ permission: 'X:read', fields: { read: ['*', '!Password'] } }` | Read grants get `fields.read`. |
| `X: { 'update:any': ['Email', 'Login'] }` | `{ permission: 'X:update', fields: { write: ['Email', 'Login'] } }` | Create and update grants get `fields.write`. |
| `X: { 'delete:any': ['Id'] }` | `'X:delete'` | Delete grants carry no fields (`delete-fields` note). |
| `X: { 'read:any': ['*'], 'read:own': ['*'] }` | `'X:read'` | The `:own` grant adds nothing (`own-under-any` note). |
| `X: { 'read:any': ['Name'], 'read:own': ['*'] }` | Both grants | `own-any-fields` warning: 3.0 gives every row the `:any` fields. |

The converter writes one grant per verb, never `X:*`. In 3.0 a glob would also grant every action registered later on `X`, such as `user:impersonate`. See [the migration guide](../authz/migration-guide.md#45-why-four-grants-and-never-x).

## `:own` grants and relations

- Without a `scope:` token, `:own` becomes relation `owner`: the row's owner is the caller. 3.0 needs `@Owner()` on the model's owner column, or a `RelationResolver` for route checks.
- For each resource in `--self-resources` (default `['user']`, constant `DEFAULT_SELF_RESOURCES`) it becomes relation `self`: the row is the caller's own account. A `self-relation` warning says so, since a default `@OrmPermission` policy on that resource is ignored by `self`.
- `scope:x` becomes relation `x`. 3.0 has no query form for an app scope: the `scope-relation` finding asks for roles on each row and a `RelationResolver` for `x` until then.
- `relations` in the `convertGrants()` result maps each resource to the relations its `:own` grants use; `analyze()` checks them against the `--src` scan.

## Impersonation

The 2.x virtual resource `user:impersonate` (constant `IMPERSONATE_RESOURCE`) becomes the 3.0 permission `user:impersonate`:

- `'user:impersonate': { 'create:any': [...] }` gives the grant `'user:impersonate'`.
- Any other action on it granted nothing in 2.x: manual `impersonate-action` item, nothing written.
- A `scope:` token on it is refused.

## Package grants and `$extend`

The 2.x packages granted keys of their own (`guest`, `user`, `admin.users`; see `RBAC_2X_PACKAGE_GRANTS`), and 2.x joined an app's list on the same key with the package list before reading it.

- An app list on such a key with only plain fields is converted, with a `package-grant` note: 3.0 keeps both grants, the same union.
- An app list on such a key with a `!` negation or a `scope:` token is refused: in 2.x it narrowed the package grant, which 3.0 keeps apart.
- An app `$extend` on `system` or `admin` is written without the package part, with a `package-extends` note. The 3.0 packages define their own `system`, `admin` and `admin.users`.

## Declared roles (`rbac.roles`)

| 2.x entry | Result |
| --- | --- |
| `{ Name, Description }` of a granted role | `description` set on that role. |
| A role granted in another layer | Only the description is written, merging into that role. |
| A role with no grants anywhere | Written with `grants: []` so its assignments stay valid; `declared-without-grants` warning. |
| A name that differs from a granted role only in case | Not written; `role-case` warning. |

Two roles whose names differ only in case are both kept, with a `role-case` warning: 3.0 role names keep their case.

## Assignable roles (`--db`)

With [database rows](01-running-the-converter.md#database-rows---db), `markAssignable()` writes `assignable: false` on every role that:

- no user or token holds,
- another role extends,
- `rbac.roles` does not declare,
- is neither `guest` nor the `rbac.defaultRole` of any view.

An `assignable` note lists them. Without `--db` every role stays assignable, as in 2.x, and the note lists the candidates.

## Refusals

`convertGrants()` sends these to `ConversionError` (see [Findings and refusals](05-findings-and-refusals.md#what-the-converter-refuses)):

- `rbac.grants` that is not an object, a role or resource that is not an object;
- an invalid role name or resource name, a malformed `$extend`, a role extending itself;
- an action key `accesscontrol` rejects;
- an attribute list that is not an array of non-empty strings, or has attributes with spaces around them;
- a field attribute that is not a 3.0 field glob;
- a `scope:` token on an `:any` grant, a token that is not a valid relation name, `scope:owner` or `scope:self`;
- `scope:` tokens with negated fields only;
- a negation or `scope:` token on a key a 2.x package also granted;
- `rbac.roles` that is not an array of objects with a non-empty `Name`.

`convertLayers()` adds one more: an attribute list set in common and in an env file for the same role, resource and action, since 2.x joined the two lists before reading them.

## Patterns and antipatterns

```ts
// Don't: a logical resource name with a colon; the converter refuses it
rbac: { grants: { partner: { 'ArrowClient:yourscreen': { 'read:any': ['*'] } } } }

// Do: rename it in 2.x first, in the config and in the controllers that name it
rbac: { grants: { partner: { 'ArrowClient.yourscreen': { 'read:any': ['*'] } } } }
```

```ts
// Don't: one attribute list split over common and env files; the converter refuses it
// rbac.js       rbac: { grants: { editor: { Article: { 'read:any': ['*'] } } } }
// rbac.prod.js  rbac: { grants: { editor: { Article: { 'read:any': ['!Draft'] } } } }

// Do: leave the key out of common and set the complete list in each env file
// rbac.prod.js  rbac: { grants: { editor: { Article: { 'read:any': ['*', '!Draft'] } } } }
// rbac.dev.js   rbac: { grants: { editor: { Article: { 'read:any': ['*'] } } } }
```

## Examples

### Convert one role set without loading files

```ts sample
import { Findings, convertGrants } from '@spinajs/authz-convert';

export function previewRoles(): void {
  const findings = new Findings('common');
  const result = convertGrants(
    {
      grants: {
        'partner.backoffice': {
          $extend: ['user'],
          Campaign: { 'read:own': ['scope:partner'], 'update:own': ['scope:partner'] },
          Report: { 'read:any': ['*', '!Margin'] },
        },
      },
    },
    { selfResources: ['user'] },
    findings,
  );
  if (findings.problems.length > 0) throw new Error(findings.problems.join('\n'));
  console.log(JSON.stringify(Object.fromEntries(result.roles), null, 2));
  console.log([...result.permissions.keys()]);
}
```

This prints `partner.backoffice` with `extends: ['user']`, the grants `{ permission: 'Campaign:read', relation: 'partner' }`, `{ permission: 'Campaign:update', relation: 'partner' }` and `{ permission: 'Report:read', fields: { read: ['*', '!Margin'] } }`.

## Related

- [Migration guide, section 3.1](../authz/migration-guide.md#31-authorization-keys): the 3.0 meaning of each converted grant.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): compiles the role definitions the converter writes.
- [`@spinajs/authz`: the RBAC model](../authz-rbac/README.md): roles, grants, relations and field lists in 3.0.
