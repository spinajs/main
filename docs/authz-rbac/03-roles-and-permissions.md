# Roles and permissions

A role is a name with grants; a grant gives one permission, or every permission a glob matches. Define roles under `authz.rbac.roles`; `ConfigRoleStore` reads them and `RbacModel` compiles them into a role graph and a grant index at boot.

Role definitions are global: `org.admin` means the same in every org. Who holds a role, and where, is an assignment ([Assigning roles](04-assigning-roles.md)).

## How it works

1. You declare the permission in `authz.permissions` (core config). A literal grant of an undeclared permission fails boot with `UnknownPermission` (B02).
2. `ConfigRoleStore.load()` reads `authz.rbac.roles` and `authz.rbac.ladders`, turns a string grant into `{ permission }`, applies each role's `revoke` list and sets `source: 'config'`. A malformed entry throws `AuthzConfigError` naming the key.
3. `RbacModel.init()` calls `compileRoles`: it refuses a role defined twice, an `extends` to an unknown role, a cycle (B12) and a mix of deny and permit roles, and computes each role's closure (the role, then every role it reaches, nearest first).
4. `RbacContributor.contribute()` runs at boot, after every model registered its permissions, and calls `RbacModel.grantIndex()`. `compileGrants` expands globs, follows `PermissionDef.implies` and checks `fields`. A bad grant fails the boot.
5. The contributor hands the boot checks a permission ref per literal grant and a relation ref per relation and permission type. A relation with no `RelationResolver` for the type fails boot (boot rule 8).
6. At runtime a role holds the grants of its whole closure. The model reloads the roles when the store version changes ([How a check resolves](05-check-resolution.md#role-definitions)).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.roles.<name>` | object | none | role name: no edge whitespace, no leading digit, not `true`/`false`, at most 128 characters | One role. |
| `authz.rbac.roles.<name>.grants` | `(string \| GrantDef)[]` | `[]` | permission names, globs or grant objects | What the role gives. |
| `authz.rbac.roles.<name>.extends` | `string[]` | `[]` | role names | Roles whose grants this role inherits. |
| `authz.rbac.roles.<name>.revoke` | `string[]` | `[]` | permission names, exact (no globs) | Drops this role's own grants of these permissions after every config fragment merged. Inherited grants stay. |
| `authz.rbac.roles.<name>.assignable` | `boolean` | `true` | `true`, `false` | `false`: the role exists only to be extended; an assignment of it is refused (`not_assignable`). |
| `authz.rbac.roles.<name>.scopeTypes` | `string[]` | none (every scope) | non-empty list of resource types, `$global` included | Scope types where the role may be assigned (`wrong_scope_type` otherwise). |
| `authz.rbac.roles.<name>.deny` | `boolean` | `false` | `true`, `false` | A deny role: subtracts its permissions. |
| `authz.rbac.roles.<name>.subjectSet` | `boolean` | `false` | `true`, `false` | Its holders form a set that can be a subject ([Assigning roles](04-assigning-roles.md#teams-groups-and-other-subject-sets)). |
| `authz.rbac.roles.<name>.ladder` | `string` | none | a ladder name | See [Ladders](06-ladders-tags-and-implied-roles.md). |
| `authz.rbac.roles.<name>.implies` | `ImpliedRole[]` | none | | See [Implied roles](06-ladders-tags-and-implied-roles.md#implied-roles). |
| `authz.rbac.roles.<name>.description` | `string` | none | | Free text. |

A grant object (`GrantDef`):

| Key | Type | Meaning |
| --- | --- | --- |
| `permission` | `string` | A permission name or glob (`invoice:*`, `*.metadata:read`, `*`). Required. |
| `relation` | `string \| string[]` | The row must stand in this relation to the principal (`owner`, `self`, ...). Several are OR-ed (B15). |
| `on` | `{ type, id? }[]` | Resource patterns; several are OR-ed. See [Resource patterns](#resource-patterns). |
| `fields` | `{ read?, write?, hide? }` | Field globs, only on permissions declared with `fields: true`. |
| `requiresTag` | `string` | Counts only when the assignment carries the tag ([Tags](06-ladders-tags-and-implied-roles.md#tags-requirestag)). |
| `grantedAt` | `string[]` | Counts only for assignments made at these scope types ([Provenance](06-ladders-tags-and-implied-roles.md#provenance-grantedat)). |

```ts
export default {
  authz: {
    permissions: {
      'invoice:read': { fields: true },
      'invoice:approve': {},
      'invoice:delete': { consistency: 'fresh' },
    },
    rbac: {
      roles: {
        'invoice.viewer': { assignable: false, grants: [{ permission: 'invoice:read', fields: { read: ['*', '!InternalNote'] } }] },
        accountant: { extends: ['invoice.viewer'], scopeTypes: ['org'], grants: ['invoice:approve'] },
        'org.owner': { extends: ['accountant'], scopeTypes: ['org'], grants: ['invoice:delete'] },
        clerk: { grants: [{ permission: 'invoice:read', relation: 'owner' }] },
      },
    },
  },
};
```

## Grants in detail

### Inheritance (`extends`)

- A role holds its own grants and those of every role in its closure. `org.owner` above holds `invoice:delete`, `invoice:approve` and `invoice:read`.
- `extends` follows the graph transitively. A cycle fails boot with `Role extends cycle: 'a' -> 'b' -> 'a'`.
- `assignable: false` keeps a building block from being assigned by mistake. Package configs use it for roles meant to be extended.
- `ceiling.roles` (a role switch, token roles) keeps assignments by the assigned role's own name. It does not follow `extends` and takes no globs.

### Globs and implied permissions

- `*` matches any run of characters except `:`. `**` is invalid. `*` alone matches every permission.
- A glob that matches no registered permission is accepted and logged as a warning, so a config fragment of an optional package stays bootable.
- A grant of `fs:write` also gives every permission `fs:write` implies (`PermissionDef.implies`), transitively.

### Relations

- `relation: 'owner'` turns the grant into "rows whose `@Owner()` column holds the principal's id". `@spinajs/authz-orm` supplies `owner` for every `@AccessResource` model with an `@Owner()` column.
- `relation: 'self'` means "the principal's own account". `@spinajs/users` supplies it on `user` ([Authz resources and relations](../users/11-authz-resources-and-relations.md)).
- Any other relation works for single checks through your own `RelationResolver`, but its permission cannot be `list: true` (boot rule 12). Assign a role on the resource instead.

### Resource patterns

`on` limits a grant to resources:

| Pattern | Admits |
| --- | --- |
| `{ type: 'invoice' }` | Every `invoice`. |
| `{ type: 'folder', id: 'f-1' }` | `folder:f-1` and every resource below it, of any type. |
| `{ type: 'file', id: 'reports-*' }` | `file` ids the glob matches (`*` only; `?` and `[` are refused). |
| `{ type: 'folder', id: 'home/{principal.id}' }` | The node built from the principal's id, and below it. |

- Templates are `{principal.id}`, `{principal.type}` and `{principal.attributes.<path>}`. A missing, empty or non-scalar value makes the pattern match nothing.
- `{principal.id}` and `{principal.type}` must stay one path segment: a value with `/`, `.` or `..` segments matches nothing.
- An empty `on` and an unknown key in a pattern fail boot.
- Lists support type-only patterns; a pattern with an `id` makes the permission unlistable.

### Fields

- `fields: { read: ['*', '!Password'], write: ['Email'] }`. A list left out means every field.
- `hide: ['X']` in a grant equals `'!X'` in that grant's `read` and `write`. Another grant that names the field still gives it.
- A grant without `fields` gives every field before `authz.fields.neverRead` applies.
- `fields` on a literal permission without `fields: true` fails boot. On a glob, the fields reach only the matched permissions that take fields; a warning names a glob whose fields reach none.

### Deny roles

A role with `deny: true` subtracts its permissions from its subject at its scope and below. It beats every permit (other roles, `owner`, `self`, `$global`, ABAC) with the reason `role_denied`.

```ts
authz: { rbac: { roles: { 'invoice.blocked': { deny: true, grants: ['invoice:approve', 'invoice:delete'] } } } }
```

- Its grants are plain permissions or globs: `relation`, `on`, `fields`, `requiresTag` and `grantedAt` fail boot.
- It cannot be a subject set, sit on a ladder or imply roles, and no `extends` or ladder edge joins a deny role and a permit role.
- A deny follows no `PermissionDef.implies`.
- Ceilings (role switch, token roles, links) never drop a deny assignment. `SYSTEM` is not subject to assignments.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Role store | `RoleStore`, registered by `registerRbacStores`; `ConfigRoleStore` is `@Injectable()` under its class name | `ConfigRoleStore` | `MemoryRoleStore`, your own | Name a registered class in `authz.rbac.stores.roles`; see [Custom stores](11-custom-stores.md). |

`ConfigRoleStore.version()` is a SHA-256 of the canonical JSON of `authz.rbac.roles` and `authz.rbac.ladders` (key order does not count, list order does). A runtime change of those keys is picked up at the next role version check.

Exported helpers: `compileRoles(roles, ladders, opts)` returns a `RoleGraph`; `assignmentProblem(graph, role, scope)` returns `'unknown_role'`, `'not_assignable'`, `'wrong_scope_type'` or `undefined`; `compileGrants(graph, registry)` returns the `GrantIndex`. `@spinajs/users` uses the first two to check `authz.rbac.defaultRoles` at boot.

## Important behaviour

- **Boot fails closed.** Every malformed role, grant, pattern or field set throws `AuthzConfigError` (or `UnknownPermission`) at boot and names the role and its source.
- **Role arrays concatenate.** Package fragments add roles and grants; an app cannot drop a fragment's grant by redefining the role, so use `revoke`.
- **Union of roles (H1).** Effective permissions are the union of all live assignments' grants. No role shadows another, except a deny role.
- **Assignments of unknown roles are ignored** and logged once per role. Assignments that break `assignable` or `scopeTypes` (rows written before the role changed) are ignored and logged once per row.
- **Reload fails closed.** When reloaded roles do not compile, RBAC votes fail until a reload succeeds; the model does not keep the last good graph.

## Best practices

- Give every permission one owning role and build bigger roles with `extends`, so `authz:check-config --explain-role <role>` lists a readable closure.
- Set `scopeTypes` on every role meant for one kind of resource (`org.admin` at `['org']`); without it the role may be assigned at `$global` and reach everything.
- Mark building-block roles `assignable: false`, so no admin and no import script can assign them.

## Patterns and antipatterns

```ts
// Don't: a custom relation makes the permission unlistable and needs a RelationResolver per type
roles: { editor: { grants: [{ permission: 'task:update', relation: 'assignee' }] } }

// Do: grant the role on the resource; the assignment is the relation
roles: { 'task.editor': { scopeTypes: ['task'], grants: ['task:update'] } }
```

```ts
// Don't: redefining a package role to drop a grant; config arrays concatenate, the grant stays
rbac: { roles: { 'team.admin': { grants: ['team:update'] } } }

// Do: revoke the package grant by name
rbac: { roles: { 'team.admin': { revoke: ['team:invitations.manage'] } } }
```

## Examples

### Add a permission and give it to a role

```ts
export default {
  authz: {
    permissions: {
      'report:read': { types: ['report'] },
      'report:export': { types: ['report'], description: 'Export a report as CSV' },
    },
    rbac: {
      roles: {
        analyst: { scopeTypes: ['org'], grants: ['report:read', 'report:export'] },
      },
    },
  },
};
```

Restart, or let the model pick the change up at its next role version check. Then assign `analyst` at an org ([Assigning roles](04-assigning-roles.md)).

### Let users read only their own home folder

```ts
authz: {
  permissions: { 'file:read': { types: ['file', 'folder'] } },
  rbac: { roles: { user: { grants: [{ permission: 'file:read', on: [{ type: 'folder', id: 'home/{principal.id}' }] }] } } },
}
```

## Related

- [Assigning roles](04-assigning-roles.md): who holds a role, and where.
- [Ladders, tags and implied roles](06-ladders-tags-and-implied-roles.md): ranked roles and conditional grants.
- [`@spinajs/authz` concepts](../authz/01-check-flow.md#concepts): permissions, `authz.permissions`, residual filters.
- [Grant and role conversion](../authz-convert/04-grant-and-role-conversion.md): how 2.x `rbac.roles` become these roles.
