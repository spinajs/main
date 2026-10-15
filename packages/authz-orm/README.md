# @spinajs/authz-orm

The ORM adapter of SpinaJS authorization. It declares which models are access resources, keeps their
ancestors in a closure table, filters lists with one helper, adds per-row access to list responses, and
holds the decision audit and scope attribute stores.

It never rewrites a query. Single objects are checked before access; lists ask for filtering
explicitly.

## Install

```ts
import '@spinajs/authz-orm';   // registers the adapter, the write middleware and the list compilers
```

Migrations: `AuthzResourceAncestor_2026_10_14_00_00_00` (`authz_resource_ancestor`),
`AuthzScopeAttribute_2026_10_02_00_00_00` (`authz_scope_attribute`), `AuthzAudit_2026_10_01_00_00_00`
(`authz_audit`). The ancestor table lives on the connection of the authz stores
(`authz.rbac.connection`, else `authz.admin.connection`, else the default), which must be the database
of the resource tables: the list filter joins them. The domain boot refuses an `@AccessResource` model
with `@Parent` on another connection (`AuthzConfigError`).

## Declaring resources

```ts
import { AccessResource, Owner, Parent, Self, registerAccessResource } from '@spinajs/authz-orm';

@AccessResource('task')
export class Task extends ModelBase {
  @Parent('project') public project_id: number;
  @Parent('sprint')  public sprint_id: number;    // a second parent: both chains are ancestors
  @Owner()           public owner_id: string;     // relation 'owner'
}

@AccessResource('folder')
export class Folder extends ModelBase {
  @Parent('folder', { nullable: true }) public parent_id: number;   // self-reference: any depth
  @Parent('project')                    public project_id: number;
}

// a model your package does not own
registerAccessResource(DbConfig, 'configuration');
// the initiator can be any principal type: the owner holds when type and id both match
registerAccessResource(JobModel, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
```

- `@Parent(type)` names the parent's resource type; the column holds the parent's id. Int and uuid
  keys share one table (ids are stored as text).
- `@Owner()` is read from the row whenever it is needed; it is never copied, so it cannot go stale.
  Without options it matches `user` principals only; `@Owner({ typeColumn: 'owner_type' })` compares
  the principal's type with that column too, for rows owned by any principal type.
- `@Self()` marks the column that equals the principal id (`self`, for `user` principals);
  `@spinajs/users` uses its own resolver for `user`.
- Each `@AccessResource` type gets the permissions `<type>:read`, `<type>:create`, `<type>:update` and
  `<type>:delete`.
- Register every model before the authz domain boots (at import or in a `Bootstrapper`).

## Single objects

```ts
const task = await authz().runAs(SYSTEM, 'load task', () => Task.where('id', id).first());
await authz().assert(me, 'task:update', task);
```

Routes keep `@Access('task:update', { resource: fromModel(Task, 'task') })`. The adapter answers
`ancestors(ref)` with one indexed read, `load(ref)` by primary key as `SYSTEM`, and `owner` from the
`@Owner` column. `checkAll` (and `POST /user/access/checks`) loads a page of rows with one query per
type (`loadMany`, `ancestorsMany`).

A **create** is checked against the parent; a **move** (writing a `@Parent` column) needs a check of
the new parent. The ORM checks neither.

## Lists

```ts
authz: { permissions: { 'task:read': { list: true } } }   // a child domain: authz.domains.<name>.permissions

const tasks = await Task.where('status', 'open').accessible('task:read');
await Task.update({ archived: true }).where('done', true).accessible('task:update');
const teamTasks = await Task.query().within({ type: 'team', id: teamId }).accessible('task:read');
```

Permission names are compared exactly: `@AccessResource('task')` registers `task:read`, never
`Task:read`.

- `.accessible(permission)` asks `authz().accessPlan(principal, permission, type)` and adds one
  `EXISTS` filter: a grant on the row, a grant on any ancestor, the owner column, minus deny roles,
  inside the principal's ceiling. It works on SQLite, PostgreSQL, MySQL and MSSQL, with no recursion.
  `{ env }` as the second argument passes request facts to ABAC.
- A plan with no permit at all throws `AccessDenied` (a 403, never an empty list). A permission
  without `list: true` throws `AuthzConfigError`.
- **Boot rule 12** refuses a `list: true` permission when anything that can grant it on the type needs
  the row: an RBAC grant with a relation other than `owner` or `self` or limited to ids by `on`, an
  RBAC `cap`, `restrict` or `threshold` rule, an ABAC policy that is scoped or reads `resource.*` or
  `scope.*` (other than `$global`), a type with no `@AccessResource` model, or a route other than
  `deny-overrides`. `AuthzAdmin` refuses the same at write time (`not_list_filterable`).
- The caller's where stays one group: `(where) AND (plan) AND (within…)`.
- `.within(ref | refs)` keeps rows that are one of the refs or lie below one in the resource tree (any
  scope type: a team, a project, a folder; `{ type }` alone means any resource of that type, `$global`
  keeps every row). The refs of one call are OR-ed, chained calls are AND-ed, `[]` keeps nothing. It
  narrows a list and authorizes nothing: a select still needs `.accessible()`, `.unscoped(reason)` or
  SYSTEM. It works on select, update and delete builders.
- `.unscoped(reason)` runs without a filter and writes an `unscoped` audit entry
  (`authz.audit.unscoped`).

### Plan terms and `PlanTermSql`

An access plan is a list of opaque terms (`{ op, args }`) from each model's `listPlan`. The adapter
renders each term with the `PlanTermSql` registered for its `op` and combines them as
`(permit OR …) AND NOT (deny OR …)`. A term with no compiler fails the query with `AuthzConfigError`.

| op | Registered by | Renders |
|---|---|---|
| `relation.owner` | authz-orm | the `@Owner()` column (and its `typeColumn`) is one of `args.principals` |
| `relation.self` | authz-orm | the `@Self()` column is one of the `user` principals in `args.principals` |
| `rbac.assignment` | authz-rbac (`RbacAssignmentSql`) | the `EXISTS` over `authz_assignment`, `authz_subject_membership` and `authz_resource_ancestor` |

A model that adds list support registers a compiler for each op its `listPlan` returns:

```ts
import { PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';

@Singleton()
@Injectable(PlanTermSql)
export class TenantSql extends PlanTermSql {
  readonly op = 'myapp.tenant';   // listPlan returns { op: 'myapp.tenant', args: { tenant: '42' } }
  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return { sql: `${row.rowColumn('tenant_id')} = ?`, bindings: [(args as { tenant: string }).tenant] };
  }
}
```

`SqlRowContext` gives the `type`, `rowId` (SQL yielding the row id as text), `rowColumn(column)`, the
`ancestorTable`, the `owner`/`self` relation columns, `now` and the `dialect` (`sqlite`, `postgres`,
`mysql`, `mssql`). The SQL must keep exactly the rows a check of each one would allow: boot rule 12
guarantees that for the RBAC and ABAC plans, a custom model guarantees it for its own terms.

## Per-row access

```ts
const rows = await Task.query().accessible('task:read').withAccess(['task:update', 'task:delete']);
// rows[i].$access = { 'task:update': true, 'task:delete': false }
```

Each permission is one boolean column built from the same filter, so a page with its access is one
query. Each permission must be `list: true`. `$access` is serialized with the row; rename it with
`authz.orm.accessField`. A client may seed its cache from it: it equals what
`POST /user/access/checks` answers.

## The runtime guard

A multi-row select on an `@AccessResource` model must call `.accessible()`, `.unscoped(reason)`, or run
in `runAs(SYSTEM, reason)`. A select on exactly one primary-key value (`@FromModel`, `findOrFail(id)`)
is a single-object load: the route's `@Access` or your `assert` covers it, and the guard leaves it alone.

| env | without one of them |
|---|---|
| `test` | `AuthzConfigError`, so CI fails |
| `development` | a warning once per call site |
| production, any other, unset | nothing |

The guard only reads the builder. A `populate()` of an `@AccessResource` type needs the helper like any
other select. Add `@spinajs/eslint-plugin-authz` (`@spinajs/authz/require-accessible`) to catch the
same at edit time.

## Nested data

`populate()`, relations, joins and sub-queries are not filtered. Authorize the aggregate root: the
comments of a task you may read are part of it. A child type that is its own resource is loaded with
the helper; the populate callback runs with the relation query as `this`:

```ts
Project.where('id', id).populate('tasks', function () { this.accessible('task:read'); });
```

## Keeping the ancestor table right

| Write through the ORM | What happens |
|---|---|
| insert of a model with `@Parent` | its rows: the parent's rows one level deeper, plus the parent |
| update of a `@Parent` column | the subtree's links above the row are replaced by the new chain |
| delete | its rows and its descendants' links above it go; the scope is forgotten |

A `@Parent` update or a delete and its table writes run in one transaction: the caller's, or one the
middleware opens. Where neither is possible the write is refused with `AuthzConfigError`.

**Deleting** a resource also deletes the assignments (the RBAC write handlers recompute the team
memberships they fed),
links, rules, policies and scope attributes at its scope and bumps `authz_version`: with
`DbAuthzAdminBackend` in the same transaction, with any other admin backend after the commit (best
effort, logged on failure). After the commit it publishes the change and writes one audit entry as
`SYSTEM` (`resource-deleted`). An id reused later inherits nothing.

Bulk moves: `reparent(Model, ids, newParentId, column?)` writes the `@Parent` column (the model's only
one unless `column` names it) in one transaction and resolves with the rows changed. Writes outside
the ORM (raw SQL, imports) are not tracked: run the CLI afterwards.

| Command | Does |
|---|---|
| `authz:ancestors-verify [type]` | recomputes from the `@Parent` columns, prints missing, extra and wrong-depth rows, exit code 1 on any |
| `authz:ancestors-rebuild [type]` | rewrites the table from the `@Parent` columns, one transaction per type |

## Database audit

`DbDecisionAudit` (from `@spinajs/authz-orm/audit`) writes one `authz_audit` row per audit record:
`id` (uuid), `at`, `kind`, `principal` (`type:id`), `permission`, `resource` (`resourceKey`),
`reason`, `trace` (JSON; for an `admin` record the command). Longer values are cut to the column
widths. A failed write is logged (`authz-audit`) and the record dropped; it never fails a check.

1. Import `@spinajs/authz-orm/audit` before the ORM boots. It registers the `AuthzAuditEntry` model
   and the migration `AuthzAudit_2026_10_01_00_00_00`, both on the connection named `authz-audit`.
2. Map that name: `db.Aliases: { 'authz-audit': 'default' }`, or configure a connection of that
   name. Without one the migration is skipped with a warning and every record fails.
3. Register and select it: `DI.register(DbDecisionAudit).as(DecisionAudit)` (or in a domain's
   container), with `authz.audit.service: 'DbDecisionAudit'` (or `authz.domains.<name>.audit.service`).

The import does not register it as the `DecisionAudit`: without `authz.audit.service` the host takes
the last one registered, so loading the module would silently replace the log audit.

`at` holds UTC time without an offset, whatever the server's time zone, so rows from hosts in other
zones compare and the hour repeated when daylight saving ends sorts right. Through the model it reads
back as a luxon `DateTime` in the local zone; `at.setZone('utc', { keepLocalTime: true })` gives the
instant.

## Scope attributes

`DbScopeAttributeStore` keeps `authz_scope_attribute`, written through `AuthzAdmin`
(`scope.setAttributes`, `scope.replaceAttributes`).

## Config

| Key | Default | Meaning |
|---|---|---|
| `authz.orm.domain` | `'root'` | the domain whose service plans lists and whose stores a delete cleans up |
| `authz.orm.accessField` | `'$access'` | the per-row access key of `.withAccess()` |

## From 3.0.0-rc.1

`@ScopeColumn` is `@Parent`; `@OrmScope` relations become role assignments on the resource;
`relationScope`, `authz.orm.allowJit` and the native compiler exports are gone; selects call
`.accessible()`. Step by step:
[the migration guide, section 12](../../docs/authz/migration-guide.md#12-from-query-scoping-2x-and-300-rc1).
