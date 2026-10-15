# Resource access without query rewriting: design

Date: 2026-10-14. Status: built (plan: `docs/superpowers/plans/2026-10-14-authz-resource-access/`; deviations in its overview, "Decisions made while planning").

Replaces the list-scoping half of `2026-10-01-authz-v3-design.md`: the `@spinajs/authz-orm` query
middleware, the residual-to-SQL compilers and the RBAC rule SQL forms. The engine, the models, `@Access`,
`AuthzAdmin` and the stored assignments stay.

The removed code is kept on the branch `archive/authz-orm-query-scoping` (cut from `feat/authz-v3` at
`f616796fc`).

## 1. Decision

1. **Single objects are checked before access.** Load the id, `authz().check()`, then run the operation.
   No query is rewritten.
2. **Lists use one explicit helper**, `query.accessible(permission)`. It adds one fixed `EXISTS` shape
   against `authz_assignment` and a new closure table, `authz_resource_ancestor`.
3. **The hierarchy is a closure table** (option A of the 2026-10-14 discussion). The declared `@Parent`
   foreign keys are the source of truth, and the table is a cache over them that can be verified and
   rebuilt.
4. **A permission is list-filterable only when every grant and policy behind it can be decided without
   reading the resource row.** A permission that is not list-filterable is refused, never approximated:
   at boot for config, and at write time for `AuthzAdmin` commands (§7).
5. **Nested data is authorized at its aggregate root.** Relations are not scoped automatically (§8).
6. **Team membership is materialized** in `authz_subject_membership`, the transitive closure of subject
   sets, so neither a check nor a list flattens teams in app code (§4.3).
7. **Deleting a resource cleans up its authz data** in the same transaction: ancestor links, and the
   assignments, links, rules and scope attributes at its scope (§6.4).
8. **Migrations are edited in place**, since 3.0 is unreleased (§4.5).
9. **Deny roles and wildcard subjects are in the core.** A role marked `deny: true` subtracts its
   permissions on its scope and below. The subject `user:*` stands for every principal of that type. Both
   work for checks and for lists (§4.2, §6.2).
10. **Clients get one universal access API** (§10): batch checks, per-row access in list responses,
    change push, and a typed model export. It is not tied to any UI kit. ckit is its first consumer, and
    §10.7 shows ckit compliance.

## 2. Why

The query middleware rewrites every select, update and delete of an `@AccessResource` model. That made
these hard or impossible to get right: populated relations, many-to-many junctions, sub-queries,
`clone()`, `whereExist` in nested groups, `toDB()` before execution, and builder reuse across principals.
It needed a SQL compiler for rule residuals that only supports SQLite and PostgreSQL, refuses Postgres
with `jit = on`, and costs 90-200 ms per list in the canvas benchmark. All told, that is about 4.2k lines in
`authz-orm` plus `authz-rbac/src/orm` and `stores/rule-sql-form.ts`.

Zanzibar-style systems (Ory Keto, OpenFGA, SpiceDB) take the same line as this design. They check single
objects before access. For lists, they leave the app to choose: fetch the visible ids, post-filter, or
join against a materialized permission table (SpiceDB Materialize, Zanzibar's Leopard index). This design
takes the third option, kept inside the app's own database and written in the same transaction as the
resource.

## 3. Scope

| Need | Check | List |
|---|---|---|
| Role assigned to a user on a resource | yes | yes |
| Role assigned to a team (subject set), nested teams | yes | yes |
| Role assigned to everyone of a type (`user:*`) | yes | yes |
| Deny role (`blocked` on `invoice:42`, or on a folder and so below it) | yes | yes |
| Role at an ancestor scope (org > project > folder > task) | yes | yes |
| Role at `$global` or at the type level (`{ type: 'task' }`) | yes | yes, no filter needed |
| `owner` and `self` relations (a column equal to the principal) | yes | yes |
| `extends`, ladders, `implies`, permission globs | yes | yes, expanded in app |
| `grantedAt`, `requiresTag` (read the assignment row) | yes | yes |
| Expiry | yes | yes |
| Ceilings (token roles, link scope, role switch) | yes | yes |
| ABAC on principal, actor, env (MFA, time, IP) | yes | yes, decided before the query |
| ABAC reading `resource.*` | yes | refused (§7) |
| RBAC `cap`, `restrict`, `threshold` rules | yes | refused (§7) |
| Other relations (`@OrmScope` SQL) | removed | removed |

Relations other than `owner` and `self` become roles assigned on the resource. For example, "team editor of
task 7" is an assignment of `editor` on `task:7` to the subject set `team:42#member`.

## 4. Data model

### 4.1 `authz_resource_ancestor` (new)

```
authz_resource_ancestor(
  resource_type  varchar(64)  not null,
  resource_id    varchar(64)  not null,
  ancestor_type  varchar(64)  not null,
  ancestor_id    varchar(64)  not null,
  depth          int          not null,     -- 1 = direct parent
  PRIMARY KEY (resource_type, resource_id, ancestor_type, ancestor_id)
)
INDEX authz_resource_ancestor_up (ancestor_type, ancestor_id)   -- subtree lookups on move and delete
```

- One row per proper ancestor. No self row and no `$global` row: a direct grant and a global grant are
  separate branches of the list query (§6.2), so models without `@Parent` need no rows at all.
- More than one parent is allowed: a task in a project **and** in a sprint holds the rows of both chains.
- Ids are strings, so int and uuid primary keys share one table. The list query casts the outer row id,
  which keeps the index usable.
- The table lives on the connection of the authz stores (`authz.rbac.connection`). It must be the same
  database as the resource tables, because the list query joins them. A model on another database is
  not list-filterable, and boot refuses it.

### 4.2 `authz_assignment` (changed)

Add `subject_key varchar(200) not null`: the principal key `type:id` for a principal, and
`type:id#role` for a subject set. Index `(subject_key, role)`. A row-value `IN` over three columns is not
portable (MSSQL, older SQLite), and one key column is. `DbAssignmentStore` writes it, and a migration
back-fills it.

**Wildcard subjects.** The subject `{ type: 'user', id: '*' }` is stored with `subject_key = 'user:*'`.
It matches every principal of type `user`, so a public-to-signed-in-users grant on one object is one row.
`anonymous:*` covers anonymous callers. `*:*` is refused. A wildcard may also be a set member
(`team:eng#member` ← `user:*`).

**Deny roles.** A role defined with `deny: true` is stored like any other assignment:

```ts
authz: { rbac: { roles: {
  blocked: { deny: true, grants: ['invoice:edit', 'invoice:delete'] },
} } }
```

- An assignment of a deny role subtracts its permissions from its subject, on its scope and every
  descendant. A deny wins over every permit: other roles, `owner`, `self`, `$global` grants and ABAC
  permits. This matches the default `deny-overrides`, and the vote's reason is `role_denied`.
- A deny role takes plain permissions or globs only. It has no `relation`, `fields`, `requiresTag` or
  `grantedAt`, and it cannot extend a permit role, or be extended by one. Boot refuses each of these.
- Ceilings never drop a deny assignment. A role switch, token roles and a link ceiling narrow permits
  only, so they cannot be used to escape a deny.
- `SYSTEM` is not subject to assignments, deny roles included.
- `DefaultAdminGuard`: granting a deny role needs the same command permission as any grant. It is not an
  escalation. The `last_holder` and `self_lockout` checks treat a deny of the privileged permission like
  a revoke.

### 4.3 `authz_subject_membership` (new)

The transitive closure of subject sets: every set a subject belongs to, directly or through nested sets.

```
authz_subject_membership(
  member_key  varchar(200) not null,   -- principal key 'user:42', or a set key 'team:7#member'
  set_key     varchar(200) not null,   -- 'team:1#member'
  depth       int          not null,   -- 1 = direct member
  expires_at  datetime,                -- null = never
  PRIMARY KEY (member_key, set_key)
)
INDEX authz_subject_membership_set (set_key)   -- who is in a set, for recomputation
```

- **Source of truth:** the assignments that put a subject into a set, i.e. `set.addMember`, which
  assigns the set's role at the set's scope. The table is derived from them.
- **Expiry:** a membership is live while any path to the set is live. The row's `expires_at` is the
  latest, over all paths, of the earliest expiry along that path. Expiry needs no job: queries compare
  `expires_at` with now, as for assignments.
- **Maintenance:** `DbAuthzAdminBackend` recomputes the closure in the batch's transaction for every
  member a command touches: `set.addMember`, `set.removeMember`, and grant, revoke and set-expiry on a
  `subjectSet` role. Recomputing one member walks at most `authz.rbac.maxSetDepth` (default 8) levels. A
  cycle is refused when written (`set_cycle`).
- **Readers:**
  - `RbacModel` reads a principal's sets with one query;
  - `accessPlan` turns the subject `IN` list into a sub-query (§6.2), so a principal in many teams
    costs nothing extra in the list SQL;
  - the `group` principal (`authz.rbac.groupPrincipal`) keeps speaking for its set.
- **CLI:** `authz:membership-verify` and `authz:membership-rebuild`, as for ancestors (§6.4).

### 4.4 Removed

- From `authz_rule`, the SQL-form columns (`resource_like`, `resource_glob`, `when_*`, `rank_*`, …).
  Rules become check-only, so `definition` is enough.
- The `native:*` residual leaves, `authz.abac.scopeResiduals` and `authz.orm.allowJit`.

### 4.5 Migrations

3.0 is unreleased, so the existing migrations are edited in place; an rc.1 database is recreated, not
upgraded.

- `AuthzRbac_2026_10_01_00_00_00`: drops the rule SQL columns from `authz_rule`, adds
  `authz_assignment.subject_key` with its index, and creates `authz_subject_membership`.
- `AuthzRbacUserRoles_2026_10_01_00_01_00` writes `subject_key` on the rows it copies.
- The new `authz-orm` package creates `authz_resource_ancestor` in its own migration. It also keeps
  `AuthzAudit_2026_10_01_00_00_00` and `AuthzScopeAttribute_2026_10_02_00_00_00` unchanged.

## 5. Declaring resources

```ts
@AccessResource('task')
export class Task extends ModelBase {
  @Parent('project') public project_id: number;   // ancestor chain: task > project > ...
  @Parent('sprint')  public sprint_id: number;    // optional second parent
  @Owner()           public owner_id: string;     // 'owner' relation, read from the column
}

@AccessResource('folder')
export class Folder extends ModelBase {
  @Parent('folder', { nullable: true }) public parent_id: number;   // self-reference: any depth
  @Parent('project')                    public project_id: number;
}
```

- `@Parent(type)` names the parent's resource type. The column holds the parent's id. Several parents and
  self-references are allowed.
- `@Owner()` stays a column. It is never copied into a table, so it cannot go stale.
- `self` stays on `user` (the `users` package): the row's `Uuid` equals the principal id.
- `registerAccessResource(model, type, { parents, owner })` does the same for models a package does not
  own (`configuration-http`, `authz-queue`).

## 6. Access

### 6.1 Single objects

The ORM `ResourceAdapter` keeps its contract (`packages/authz/src/contracts/adapter.ts`):

- `ancestors(ref)`: one indexed read of `authz_resource_ancestor`, ordered by `depth`, then `GLOBAL`.
- `load(ref)`: the row by primary key, as `SYSTEM`.
- `relations()`: `owner` from the `@Owner` column, plus `self` from `users`.

Routes keep `@Access('Task:update', { resource: fromModel(Task, 'task') })`. Code outside HTTP calls
`authz().assert(me, permission, row)`.

**Batches.** `checkMany` groups its requests by type. The adapter gets two new optional methods,
`loadMany(refs)` and `ancestorsMany(refs)`, so a batch of 300 checks over one page of rows costs one row
query and one ancestor query per type. This is the path of the client API (§10.2).

**Create** is checked against the parent: `assert(me, 'Task:create', { type: 'project', id })`. Since the
row does not exist yet, the parent ref is what a grant must cover.

**Reparent** (writing a `@Parent` column) needs the app to check the new parent. The write middleware
(§6.4) cannot check permissions; it only keeps the table right.

### 6.2 Lists

`authz().accessPlan(principal, permission, type)` returns one of:

- `{ kind: 'all' }`: a `$global` or type-level grant, or an ABAC permit that reads no row, and the
  principal holds no live deny assignment covering the permission. No filter. If it does hold one, the
  plan is `filter` with only the deny clause.
- `{ kind: 'none' }`: nothing could ever grant it to this principal. `.accessible()` throws
  `AccessDenied`, which keeps H16 (a list with no permit is a 403, not an empty list).
- `{ kind: 'filter', subjects, roles, denyRoles, owner, self, ceilingScopes }`, where:
  - `subjects`: the principal key, its companions, and their wildcard keys (`user:*`). Their sets come
    from `authz_subject_membership` inside the query;
  - `denyRoles`: the deny roles whose grants cover the permission;
  - `roles`: the roles whose grants cover the permission on the type, with `extends`, ladders, `implies`
    and globs expanded, and intersected with `ceiling.roles`. A role limited by `grantedAt` or `requiresTag`
    carries that qualifier.
  - `owner` / `self`: whether a grant with that relation covers the permission.
  - `ceilingScopes`: the scopes a link or token ceiling limits the principal to.

The plan is cached under `(principal, permission, type, authz_version)`.

`query.accessible('Task:read')` turns a `filter` plan into the SQL below. `<holder>` stands for
`(s.subject_key IN (:subjects) OR s.subject_key IN (SELECT m.set_key FROM authz_subject_membership m
WHERE m.member_key IN (:subjects) AND (m.expires_at IS NULL OR m.expires_at > :now)))`.

```sql
WHERE (
  EXISTS (SELECT 1 FROM authz_assignment s                     -- direct grant on the row
          WHERE s.scope_type = 'task' AND s.scope_id = CAST(t.id AS varchar(64))
            AND <holder> AND s.role IN (:roles)
            AND (s.expires_at IS NULL OR s.expires_at > :now))
  OR EXISTS (SELECT 1 FROM authz_resource_ancestor a           -- grant on any ancestor
             JOIN authz_assignment s
               ON s.scope_type = a.ancestor_type AND s.scope_id = a.ancestor_id
             WHERE a.resource_type = 'task' AND a.resource_id = CAST(t.id AS varchar(64))
               AND <holder> AND s.role IN (:roles)
               AND (s.expires_at IS NULL OR s.expires_at > :now))
  OR t.owner_id IN (:principalIds)                              -- only when plan.owner
)
AND NOT EXISTS (                                                -- only when plan.denyRoles
  SELECT 1 FROM authz_assignment d
  WHERE <holder over d> AND d.role IN (:denyRoles)
    AND (d.expires_at IS NULL OR d.expires_at > :now)
    AND (   (d.scope_type = 'task' AND d.scope_id = CAST(t.id AS varchar(64)))
         OR EXISTS (SELECT 1 FROM authz_resource_ancestor a
                    WHERE a.resource_type = 'task' AND a.resource_id = CAST(t.id AS varchar(64))
                      AND a.ancestor_type = d.scope_type AND a.ancestor_id = d.scope_id)
         OR d.scope_type = '$global'))
AND <ceiling: the row is, or descends from, one of :ceilingScopes>   -- only when a ceiling is set
```

In a `kind: 'all'` plan with a deny, only the `NOT EXISTS` part is emitted.

- A role qualifier adds `s.scope_type IN (...)` (`grantedAt`) or a tag match on `s.tags` (`requiresTag`)
  to that role's group.
- `implies` with `at: 'descendants'` applies through the ancestor branch only.
- The shape works on SQLite, PostgreSQL, MySQL and MSSQL: `EXISTS`, `JOIN`, `IN` and `CAST`, with no
  recursion and no compiler.
- It works on select, update and delete builders, so a bulk `Task.update(...).accessible('Task:update')`
  is filtered the same way.

### 6.3 Other resources

- **Files (`authz-fs`)**: unchanged in kind. Paths are checked before access, their ancestors are the
  parent directories, and `list: 'each'` post-filters a directory listing. It never used the ORM
  middleware. `fs_object` (owners) stays.
- **Queue (`authz-queue`)**: `JobModel` is registered with `owner` on its initiator column in place of
  the `@OrmScope` `initiator` relation. `job:read` for `user` becomes `{ permission: 'job:read', relation:
  'owner' }`.
- **Anything else** (external APIs, caches): check before access through a `ResourceAdapter`, as today.

### 6.4 Keeping the closure table right

The table only changes when a `@Parent` column or a row changes. One small write-side middleware
maintains it. **It never changes a select.**

| Write | Handling |
|---|---|
| insert of a model with `@Parent` | insert its rows: the parent's rows shifted by one depth, plus the parent itself |
| update that changes a `@Parent` column | delete the subtree's links above the row; insert subtree × new ancestors |
| delete | the clean-up below |
| insert outside a transaction | allowed: a missing row only narrows access |

**Transactions.** A `@Parent` update or a delete and its table writes run in one transaction: the
caller's, or one the middleware opens around the statement. When neither is possible (a driver or call
path that cannot open one), the write is refused with `AuthzConfigError`. A crash between the statements
would leave stale ancestors or grants, which fails open.

**Clean-up on delete.** The middleware reads the ids the delete reaches before it runs (as `SYSTEM`,
in the transaction). After the delete, for each deleted `type:id`:

1. delete its ancestor rows (`resource = it`);
2. for each descendant (`ancestor = it`), delete its links to the deleted row and to every ancestor
   above it, as a reparent to nothing would. A descendant the delete did not reach (no FK cascade)
   becomes a root;
3. forget the scope: delete the assignments at `type:id` (recomputing the memberships they fed, §4.3),
   the links, the rules and policies scoped to it, and its `authz_scope_attribute` rows;
4. bump `authz_version`, and after the commit publish `AuthzChange` and write one audit entry as `SYSTEM`
   with the reason `resource-deleted`.

Step 3 runs the `scope.forget` handler's store writes directly in the caller's transaction, because
`DbAuthzAdminBackend` refuses to run inside an open transaction. This is the one write of `authz_*` data
outside `AuthzAdmin` (H22). It is framework-owned and audited. Without it, an id reused after a delete
(MySQL InnoDB before 8.0 resets `AUTO_INCREMENT` on restart) would inherit the old grants.

- **ORM change required:** `QueryMiddleware` gets `afterQueryExecution(query, result)`. Today it has
  only `afterQueryCreation` and `beforeQueryExecution`, so a builder insert has nowhere to write its
  rows. Instance saves can use the existing `ModelMiddleware.onInsert` / `onUpdate`.
- **Bulk moves** use `authz().ancestors.reparent(type, ids, newParent)`. It runs one delete and one
  insert per subtree.
- **Writes outside the ORM** (raw SQL, another service, a DB import) are unsupported for `@Parent`
  columns. Run `authz:ancestors-rebuild` after them.
- **CLI:**
  - `authz:ancestors-verify [type]` recomputes from the `@Parent` foreign keys and reports missing and
    extra rows, with exit code 1 on any difference, so it can run in CI or as a health check;
  - `authz:ancestors-rebuild [type]` rewrites the table in batches.
- A move rewrites subtree × depth rows (about 100k for a project with 50k tasks two levels down). That's
  acceptable because moves are rare and run in one transaction.

## 7. List-filterability rule

A permission used with `.accessible()` is declared so: `authz.permissions['Task:read'] = { list: true }`.
`.accessible()` on any other permission throws `AuthzConfigError`.

**Boot** refuses a `list: true` permission when anything that can match it on the type:

- is an RBAC grant with a relation other than `owner` or `self`;
- is an ABAC policy (permit or deny) whose condition reads `resource.*`;
- is an RBAC `cap`, `restrict` or `threshold` rule;
- is a type whose model has no `@AccessResource`, or lives on another database than the authz tables.

The error names the permission, the policy or rule id, and the config key.

**Write time:** `AuthzAdmin` runs the same check as an `AuthzCommandValidator` on `policy.put` and
`rule.put`. A stored policy or rule that would make a `list: true` permission non-filterable is refused
(`not_list_filterable`). So the database can never hold data the list path cannot honour, and
`.accessible()` needs no check at call time.

A permission that is not list-filterable keeps working for single objects. For lists, the app writes its
own WHERE for the row condition (`status = 'published'`) and owns the result.

## 8. Nested data

- `populate()`, relations, joins and sub-queries are **not** scoped.
- Rule: authorize the aggregate root. If a user may read `task:7`, the comments and attachments loaded
  through it are part of it. Child types that are their own resources (a `Task` loaded under a
  `Project`) must be loaded with the helper:
  `project.populate('tasks', (q) => q.accessible('Task:read'))`.
- Routes keep the registration rule: every route has `@Access`, `@AllowAnonymous` or `@Public`.
- A select on an `@AccessResource` model calls `.accessible()`, uses `.unscoped(reason)`, or runs in
  `runAs(SYSTEM, reason)`. Two layers enforce this:
  - **Runtime guard** in the write-side middleware (it only reads the builder, never changes it): a
    select that has none of the three is an `AuthzConfigError` in the `test` env, so CI fails, and a
    warning once per call site in `development`. It is off in production and in an unset env. A
    `populate()` of an `@AccessResource` type needs the helper like any other select; one of a plain
    model is not checked.
  - **ESLint rule** `@spinajs/authz/require-accessible`, a typed rule in a new package
    `@spinajs/eslint-plugin-authz`. It flags a query chain on a class decorated with `@AccessResource`
    that reaches an executing call (`await`, `.first()`, `.all()`, …) without `.accessible()`,
    `.unscoped()` or an enclosing `runAs`. It catches at edit time what the guard catches in tests,
    and misses dynamic chains, which the guard still sees.

## 9. Removal

| Item | Action |
|---|---|
| `packages/authz-orm` (middleware, compile, relations, clones, shield, jit, native) | delete; a new, small `@spinajs/authz-orm` with the same name holds §5, §6.1, §6.2 and §6.4 |
| `authz-orm/src/audit` (`DbDecisionAudit`, `authz_audit`) | keep, moved into the new package |
| `authz-orm/src/scope-attributes` (`authz_scope_attribute`) | keep, moved into the new package |
| `authz-rbac/src/orm/**`, `stores/rule-sql-form.ts`, rule SQL columns | delete |
| `authz-rbac/bench` | delete (it measured the compiler) |
| ABAC `scopeResiduals`, `native:condition.scope` | delete |
| `authz-testing` canvas-c6 ORM tests, the B06 ORM property tests | delete; B06 is rewritten over `.accessible()` |
| `authz-queue/src/job/job-resource.ts` | rewrite with `owner` |
| `configuration-http/src/bootstrap.ts` | rewrite with the new `registerAccessResource` |
| `users`, `http-socket`, `queue-http-progress` | update the dependency, and the code where it imports removed symbols |
| new: `@spinajs/eslint-plugin-authz` | add, holds `require-accessible` (§8) |
| `POST /user/access/check` (`AccessController.check`) | replaced by `POST /user/access/checks` (§10.2) |

The package name is kept because 3.0 is still at `rc.1`, so apps import the same name and only the
decorators change.

The archive branch keeps everything above in working order at `f616796fc`. Restoring a piece means
cherry-picking from it, not merging it back.

## 10. Client access API

### 10.1 Principles

- **Universal.** No `authz*` package depends on, names or special-cases a UI kit. The contract follows
  the batch-check shape of Zanzibar systems (OpenFGA, SpiceDB, Keto), which most client access libraries
  can already talk to. ckit is the first consumer. Its compliance is a conformance test in
  `authz-testing` (§10.7), not code in the server.
- **The server is the source of truth.** Clients ask; they never get a copy of the policy to evaluate
  themselves. There is no tuple export, because a client-side schema would drift from the server's.
- **Client gating is UX.** Every write is still checked by `@Access` and check-before (§6.1).
- **Fail closed.** Every answer that is not a definite allow is `false`.

### 10.2 `POST /user/access/checks`

This replaces `POST /user/access/check`. It is served by `authz-http`, in the domain
`authz.http.access.domain`.

```
POST /user/access/checks
{ "checks": [ { "object": { "type": "invoice", "id": "42" }, "permission": "edit",
                "subject"?: { "type": "user", "id": "…", "relation"?: "…" },
                "context"?: { "field"?: "amount", "fieldMode"?: "read" | "write" } } ] }

200 { "results": [ true ], "reasons": [ null ] }
```

- **Permission:** a name with `:` is used as it is (`users:delete`). Otherwise it becomes
  `${object.type}:${permission}` (`invoice:edit`). So a client can follow the `type` + action style, and
  packages whose permission type differs from the object type still work.
- **Type level:** `object.id === '*'` is the ref `{ type }` (for example "may I create an invoice").
  `object.type === '$global'` is `GLOBAL`.
- **Result:** `true` only for a definite allow: `allowed` with a `TRUE` residual after loading the row.
  Every other outcome is `false`: a conditional answer, an unknown permission, an unknown type, a
  malformed entry, a model error. A bad entry never fails the batch; it is logged.
- **Reasons:** `reasons[i]` is the decision's deny reason code (`no_access`, `role_denied`,
  `mfa_required`, …) or `null`. These are the codes 403 bodies already return (B23). Clients may use them
  for a disabled-reason text, and clients that read only `results` lose nothing.
- **Subject:** always the request's principal. An entry whose `subject` names anyone else gets `false`
  with the reason `subject_mismatch`. Checking for another subject belongs to the admin API, not here.
- **Context:** never mapped into `env`, because a client could forge `env.*` facts such as its IP. Only
  `field` and `fieldMode` (default `write`) are read. They narrow the result to
  `field ∈ decision.fields[fieldMode]`.
- **Principal:** `HasPrincipal`, so anonymous callers may ask and public pages can gate. No principal is
  a 401.
- **Limits:** at most `MAX_ACCESS_CHECKS` (100) entries. Evaluated with `checkMany` (§6.1).
- **Headers:** every answer carries `X-Access-Epoch` (§10.4).

### 10.3 Per-row access in list responses

```ts
const rows = await Task.where(...).accessible('Task:read').withAccess(['Task:update', 'Task:delete']);
// rows[i].$access = { 'Task:update': true, 'Task:delete': false }
```

- **How:** each permission becomes one boolean select column. It is the same `EXISTS` and `NOT EXISTS`
  as `.accessible()` (§6.2) wrapped in `CASE WHEN … THEN 1 ELSE 0 END`, so a page with its access costs
  one query.
- **Permissions:** each one must be `list: true` (§7).
- **Payload:** `$access` is serialized with the row. The key is configurable in `authz.orm.accessField`.
- **Clients:** they may seed their cache from it. The entry for `(object, permission)` is exactly what
  §10.2 would answer, so a seeded answer and a fetched answer never disagree.

### 10.4 Change push and the access epoch

**Push.**
- `AuthzChange` events are routed to the live sessions of the subjects they affect:
  - an assignment change goes to its subject, or to the members of a set subject through
    `authz_subject_membership`;
  - a resource delete goes to the subjects of the assignments it forgets;
  - a role, policy or rule change goes to every session.
- The event is `authz.changed` with `{ objects?: { type, id }[] }`. `objects` is present only when every
  changed scope has no descendants in `authz_resource_ancestor`. Otherwise it is left out, meaning
  "refetch everything", so an exact-object client cache is never left stale.
- Transports:
  - an `http-socket` channel;
  - `GET /user/access/events` (SSE) for clients without the socket.

  Both take the principal from the session.

**Epoch.** `X-Access-Epoch` is a per-session counter, sent on every response of `authn-http` and
`authz-http`. It changes when the principal's access may change without any authz data changing: a role
switch, impersonation start and end, MFA elevation, a token or link ceiling change. A client that sees a
new value drops its cached answers. It is deliberately not `authz_version`: that counter is
domain-wide, and every client would drop its cache on any change anywhere.

### 10.5 Typed model export

`authz:export-model [--out file.d.ts] [--domain root]` writes the registered permissions as a TypeScript
type:

```ts
export type AccessModel = { invoice: 'read' | 'edit' | 'delete'; users: 'read' | 'update' | 'delete' | 'credentials'; … };
```

It is a plain `Record<type, action union>`. ckit's `AccessRegister` model accepts it as is, and any other
TS client can use it directly.

### 10.6 Explain

The existing explain route (`authz.http.explainRoute`, never in production, H19 and B41) gains a
`format=tree` answer: `{ label, allowed, children }`, built from `Decision.trace`. The shape is generic.
It matches ckit's `ExplainNode`, so a kit's devtools can show server decisions.

### 10.7 ckit compliance

Checked against `coderush/ckit/docs/access-control.md`, 2026-10-14.

| ckit expects | Where it is met |
|---|---|
| `createHttpChecker` wire format `{ checks } → { results }` | §10.2, the defaults; no `encode` or `decode` needed |
| One answer per request, a bad request isolated | §10.2: per-entry `false`, never a batch failure |
| The subject taken from the session | §10.2 |
| Relations, usersets (`team#member`), `parent->…` walks | assignments, subject sets with membership (§4.3), ancestors (§4.1) |
| `user:*` | wildcard subjects (§4.2) |
| `and(…, not('blocked'))` | deny roles (§4.2) |
| A per-column cell edit gate | `context.field` (§10.2) |
| `initial` snapshot, `prefetch`, seeding from list data | `withAccess` (§10.3), plus ckit's seed API (below) |
| `subscribe(changed?)`, invalidation | push (§10.4); `objects` only when exact, else everything |
| Re-check after a user or role change | `X-Access-Epoch` (§10.4) |
| A typed model (`AccessRegister`) | `authz:export-model` (§10.5) |
| `explain` | `format=tree` (§10.6), development only |
| Fail closed | §10.1 |
| Anonymous pages | `HasPrincipal` (§10.2) |

`authz-testing` gains `runClientAccessConformance`. It drives §10.2 to §10.4 with the request and
response fixtures of ckit's `createHttpChecker` tests, so a change that breaks ckit fails spinajs CI.

Work in the ckit repo, tracked there and not built here:
- `access.seed(entries)` to load `$access` answers into the store;
- an `X-Access-Epoch` hook for the HTTP checker;
- a spinajs section in `access-control.md` with the conventions above;
- when the file manager moves to `ckit-access`, fs ids as `<fs>:` + `encodeURIComponent(path)`, because
  ckit ids forbid whitespace. `authz-fs` decodes them in §10.2.

## 11. Resolved (2026-10-14)

1. **Migrations:** edited in place (§4.5).
2. **Deleting a parent:** the delete cleans up the scope's authz data in the same transaction (§6.4).
3. **Enforcing `.accessible()`:** both a runtime guard and an ESLint rule (§8).
4. **Teams:** materialized in `authz_subject_membership` (§4.3).
5. **Client check endpoint:** replaces `/user/access/check` (§10.2).
6. **Deny roles:** in the core now (§4.2).
7. **Per-row access in lists, with the client cache seeded from it:** in scope now (§10.3).
8. **Change push:** in this plan (§10.4).
9. **Universality:** the authz packages know no UI kit. Each client-facing shape is a generic contract,
   and kit-specific glue lives in the kit (§10.1).

## 12. Open questions

1. **Opening a transaction from a query middleware.** §6.4 assumes the middleware can wrap one
   statement in a transaction when the caller has none. Check what `OrmDriver.transaction` allows from
   `beforeQueryExecution`. If it cannot, `@Parent` updates and deletes outside a transaction are refused
   instead.
2. **DB triggers.** For apps that write `@Parent` columns outside the ORM, generate per-driver triggers
   that maintain the table. Later, if asked.
