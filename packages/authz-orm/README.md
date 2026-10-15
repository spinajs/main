# `@spinajs/authz-orm`

ORM resources for SpinaJS authorization: declarations, single-object checks, the
`authz_resource_ancestor` closure table and the list helpers (design 2026-10-14).

## Setup

- `import '@spinajs/authz-orm'` registers `OrmResourceAdapter` (a `ResourceAdapter` for every
  `@AccessResource` type), the query middleware that keeps `authz_resource_ancestor` right, and the
  runtime guard. Register models before the authz domain boots (at import, or in a `Bootstrapper`).
- `authz.orm.domain` (default `root`) names the domain whose service plans lists and whose stores a
  delete cleans up.

## Declaring resources

```ts
@AccessResource('task')
export class Task extends ModelBase {
  @Parent('project') public project_id: number;
  @Parent('sprint', { nullable: true }) public sprint_id: number;
  @Owner() public owner_id: string;
}
```

- `@Parent(type)`: the column holds the parent's id. Several parents and self-references are allowed.
- `@Owner()`: relation `owner`, true for the `user` principal whose id the column holds;
  `@Owner({ typeColumn })` also reads the principal type from that column (any principal type). `@Self()`:
  relation `self`, true when the row is that user.
- `registerAccessResource(model, type, { parents, owner, self })` does the same for models a package
  does not own.
- Default permissions per type: `<type>:read`, `<type>:create`, `<type>:update`, `<type>:delete`.

## Database audit

`DbDecisionAudit` (from `@spinajs/authz-orm/audit`) writes one `authz_audit` row per audit record:
`id` (uuid), `at`, `kind`, `principal` (`type:id`), `permission`, `resource` (`resourceKey`),
`reason`, `trace` (JSON; for an `admin` record the command). Longer values are cut to the column
widths. A failed write is logged (`authz-audit`) and the record dropped; it never fails a check.

1. Import `@spinajs/authz-orm/audit` before the ORM boots. It registers the `AuthzAuditEntry` model
   and the migration `AuthzAudit_2026_10_01_00_00_00`, both on the connection named `authz-audit`.
2. Map that name: `db.Aliases: { 'authz-audit': 'default' }`, or configure a connection of that
   name. Without one the migration is skipped with a warning and every record fails.
3. Register and select it:
   `DI.register(DbDecisionAudit).as(DecisionAudit)` (or in a domain's container), with
   `authz.audit.service: 'DbDecisionAudit'` (or `authz.domains.<name>.audit.service`).

The import does not register it as the `DecisionAudit`: without `authz.audit.service` the host
takes the last one registered, so loading the module would silently replace the log audit.

`at` holds UTC time without an offset, whatever the server's time zone, so rows from hosts in
other zones compare and the hour repeated when daylight saving ends sorts right. Through the model
it reads back as a luxon `DateTime` in the local zone; `at.setZone('utc', { keepLocalTime: true })`
gives the instant.

## Keeping `authz_resource_ancestor` right

- Run the migration `AuthzResourceAncestor_2026_10_14_00_00_00` (connection `default`, like the RBAC
  tables). The table must be in the database of the resource tables and of `authz_assignment`.
- Writes through model builders keep it right: an insert writes the new rows' links; an update of a
  `@Parent` column recomputes the row and its subtree; a delete removes the links, turns undeleted
  children into roots, forgets the authz data at each deleted scope (assignments, links, rules, scope
  attributes) and, after the commit, publishes `AuthzChange` and audits `resource-deleted` as SYSTEM.
  `@Parent` updates and deletes run in a transaction (the caller's, or one the ORM opens).
- Bulk moves: `reparent(Model, ids, newParentId, column?)`. The app checks the new parent first.
- Raw SQL, another service or an import that writes `@Parent` columns: run
  `authz:ancestors-rebuild [type]` afterwards. `authz:ancestors-verify [type]` reports differences
  with exit code 1 (CI, health checks).

## Runtime guard

A select of many rows of an `@AccessResource` model must use `.accessible(permission)`,
`.unscoped(reason)` or run as SYSTEM (`authz().runAs(SYSTEM, reason, fn)`). A load of one row by its
primary key (`where(pk, v)`, `get(v)`, `findOrFail([v])`, `@FromModel`) is a single-object load that the
route's `@Access` check covers, and is not flagged. With `APP_ENV=test` a select without one throws
`AuthzConfigError`; with `APP_ENV=development` it warns once per call site; otherwise it is off.

## Lists

```ts
const tasks = await Task.where('status', 'open').accessible('Task:read');
await Task.update({ archived: true }).where('project_id', 7).accessible('Task:update');
const page = await Task.query().accessible('Task:read').withAccess(['Task:update', 'Task:delete']);
// page[i].$access = { 'Task:update': true, 'Task:delete': false }
```

- The permission must be declared `list: true` (`authz.permissions['Task:read'] = { list: true }`);
  `accessPlan` refuses any other with `AuthzConfigError`.
- The plan is asked for the principal the query runs as, when it executes. A plan that grants nothing
  throws `AccessDenied` (a list with no permit is a 403, not an empty list). `{ env }` passes request
  env facts: `.accessible('Task:read', { env: { ip } })`.
- The caller's where stays one group: `(where) AND (plan)`. Works on select, update and delete.
- `.unscoped(reason)` runs without a filter and writes an `unscoped` audit entry
  (`authz.audit.unscoped`).
- `.withAccess(permissions)` adds one boolean per permission, from the same SQL as `.accessible()`, in
  the same query; the key is `authz.orm.accessField` (default `$access`), sent by `toJSON()` and
  `dehydrate()`.
- Models add list support by registering a `PlanTermSql` (`@Injectable(PlanTermSql)`) for the ops
  their `listPlan` returns. Built in: `relation.owner` and `relation.self`
  (`{ principals: { type, id }[] }`; the columns come from `@Owner()` / `@Self()`).
- `populate('tasks', (q) => q.accessible('Task:read'))` works for relations that run their own query
  (has-many, many-to-many); a belongs-to populate is a join of the parent and is not filtered.
