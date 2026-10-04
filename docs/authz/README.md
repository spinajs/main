# Authorization in SpinaJS 3.0

`@spinajs/authz` answers one question: may this principal do this action on this resource?
It replaces the 2.x `rbac` authorization code (`accesscontrol`, `@Permission`, `RbacPolicy`).

- Moving a 2.x app: read [the migration guide](./migration-guide.md).
- Authentication (who is calling) is a separate family: [docs/authn](../authn/README.md).
- Rule numbers such as B11 or H1 point to the design:
  `docs/plans/2026-10-01-authz-v3-design.md` (§17 for B-rules, §3.1 for H-decisions).

Some parts are not built yet. Each gap carries a `TODO(<lane>)` note. The lane owner fills it
in when the lane merges.

## Contents

- [Packages](#packages)
- [Concepts](#concepts)
- [Using the service](#using-the-service)
- [Config](#config-authz)
- [The RBAC model](#the-rbac-model)
- [The ABAC model](#the-abac-model)
- [Adapters](#adapters)
- [AuthzAdmin](#authzadmin)
- [Testing kit](#testing-kit)

## Packages

| Package | Holds |
|---|---|
| `@spinajs/authz` | Contracts, the engine, the condition language, the DI host, `AuthzAdmin`. It knows no model. |
| `@spinajs/authz-rbac` | The RBAC model, its stores, the admin guard and the DB backend of `AuthzAdmin`. |
| `@spinajs/authz-abac` | The ABAC model (permit and deny policies). |
| `@spinajs/authz-http` | `@Access`, principal sources, field filters, `/user/access`. |
| `@spinajs/authz-http-admin` | HTTP routes over `AuthzAdmin`. |
| `@spinajs/authz-orm` | ORM adapter: query scoping. |
| `@spinajs/authz-queue` | Queue adapter: who started a job. |
| `@spinajs/authz-fs` | File system adapter. |
| `@spinajs/authz-testing` | Fakes, conformance suites and the behaviour fixtures B01-B46. |
| `@spinajs/authz-convert` | The `spinajs-authz-convert` tool for 2.x configs. |

`@spinajs/authz` depends on `@spinajs/authn` for the principal types only (`@spinajs/authn/contracts`).
No `authz*` package loads a login strategy or a session store (H29, D20).

## Concepts

**Principal.** The caller. Types: `user`, `anonymous`, `unattended`, `system`, `service`, `link`,
`agent`, `group`, or your own. A principal may carry a `ceiling` (limits that only narrow: roles,
permission globs, resources, an expiry), an `onBehalfOf` principal (agents and delegated tokens),
`companions` (the signed-in user behind a share link), `attributes` and the `authn` facts that
authentication set (`principal.authn.assurance`, `principal.authn.method`).

**Resource.** A reference `{ type, id? }`. No `id` means the whole type ("list the rows"). `GLOBAL` is
`{ type: '$global' }`. Resources form a tree through their ancestors (org, project, file), which
an adapter or a scope resolver supplies.

**Permission.** A name `resource:action`, such as `user:read` or `ArrowCampaign:update` (H4).

- Case is kept and compared exactly (H17).
- The resource part allows dots: `user.metadata:read`.
- Globs exist only in grants, policies, rules and ceilings: `user:*`, `user.*:read`, `*`. A `*`
  stands for any run of characters except `:`. `**` is invalid.
- A permission you never registered is an error, not a "no" (B02).

**Model.** A plug-in that votes. RBAC and ABAC ship in 3.0. Each vote carries two residual filters,
`permitWhen` and `denyWhen`. The engine combines the votes.

**Combination.** `deny-overrides` by default: any deny beats any permit (B03). Per resource type you
may choose `permit-overrides` or `first-applicable`. A model that throws or times out is
indeterminate and counts as a deny (B04).

**Decision.** `allowed`, the `residual`, the readable and writable `fields`, the effective `roles`,
the `reason` of a deny and an optional `trace`. `allowed: true` with a residual other than `TRUE`
means "yes, for rows that match the residual".

**Residual filter.** A predicate over the rows of one type, such as `owner = me AND org_id IN (…)`.
`TRUE` is "every row", `FALSE` is "none". One residual serves a check on one row and a list query:
for every row, `check` and `filter` agree (B06). A list that has no permit at all is a 403, not an
empty list (H16).

**Deny reason.** A code with a priority. The decision reports the reason with the lowest
`(priority, sortKey)` among all deny sources, whatever the order of models (B36). Core codes:
`no_access`, `unknown_resource`, `ceiling`, `delegate`, `unattended`, `anonymous`, `model_error`,
`needs_subject`, `residual_false`.

**Unattended and system.** Code that runs with no principal (CLI, cron, queue, a socket without a user)
gets the `UNATTENDED` principal, and every check denies it (H2, B09). To act as system you call
`authz().runAs(SYSTEM, reason, fn)`. `runAs` is audited with its reason. There is no switch that turns
unattended into system.

**Domain.** A child DI container with its own models and config. The root domain is `root`. Use a
domain when a part of the app needs different models, such as the file system (B29).

## Using the service

Resolve the service at boot. `authz()` is synchronous and never resolves anything, so it throws
`AuthzConfigError` until the domain's service has booted (F4).

```ts
import { DI } from '@spinajs/di';
import { AuthzService, AuthzDomains, authz, SYSTEM } from '@spinajs/authz';

const root = await DI.resolve(AuthzService);                       // root domain
const fs = await (await DI.resolve(AuthzDomains)).service('fs');   // any other domain

// later, anywhere in a request or a job:
const me = authz().current();                                       // ALS principal, else UNATTENDED
if (await authz().can(me, 'Task:update', { type: 'Task', id: '7' })) { /* … */ }
await authz().assert(me, 'Task:update', task);                      // throws AccessDenied (403)

// a decision with fields and a reason
const d = await authz().check({ principal: me, permission: 'users:read' });
d.allowed; d.fields.read; d.reason;

// a list: the residual an adapter turns into a WHERE clause
const filter = await authz().filter(me, 'Task:read', 'Task');

// code that has no user acts as system, on purpose
await authz().runAs(SYSTEM, 'nightly-cleanup', async () => { /* … */ });
```

Other methods: `checkMany`, `filterNow` (sync, after `preload`), `explain` (adds a trace), `summary`,
`covers(holder, target)` (the impersonation rule, B26) and `admin()`.

## Config: `authz.*`

Config goes under `authz.*` (H3). AJV validates the core keys at boot. Other packages own their
own sections (`authz.rbac`, `authz.abac`, `authz.http`, `authz.admin`).

```ts
export default {
  authz: {
    permissions: {                                 // apps declare; models and adapters add theirs
      'user:read': { fields: true },
      'users:update': { fields: true },
      'user:impersonate': {},
    },
    combine: {
      default: { algorithm: 'deny-overrides', models: ['rbac', 'abac'] },
      types: { job: { algorithm: 'first-applicable', models: ['rbac'] } },
    },
    principals: {
      anonymous: { enabled: true },                // false: no anonymous principal
      roleSwitch: { requirePassword: [] },
    },
    fields: { neverRead: ['Password'], write: { mode: 'strip' } },   // 'strip' | 'reject'
    engine: { explain: false, modelTimeoutMs: 2000, maxDelegation: 2 },
    cache: { maxEntries: 10000, ttlSeconds: 60 },  // maxEntries 0: no L2; ttlSeconds 0: no L1 either
    audit: { denials: true, runAs: true, unscoped: true },
    config: { rejectLegacyKeys: false },           // true: any rbac.* key fails boot
    domains: {
      fs: { parent: 'root', combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'fs-inherit'] } } },
    },
  },
};
```

- `authz.domains.<name>.*` applies to one domain and its children. `combine`, `engine`, `fields`, `cache`
  and `audit` override the parent's. `permissions` adds to it. `disable` drops ancestor models by
  name. `bus` and `principals` come from the root only.
- `fields.neverRead` is removed from `read` and from `write`, for every principal, `SYSTEM` included
  (B17).
- The 2.x `rbac.*` keys are not read. By default the host logs a warning that names the keys and
  `spinajs-authz-convert`. With `authz.config.rejectLegacyKeys: true` boot fails instead.
- Arrays from different config files are concatenated, so a package fragment adds roles and policies.

The keys of the HTTP adapter, the RBAC model, the ABAC model and `AuthzAdmin` are in their sections.

## The RBAC model

`@spinajs/authz-rbac` holds roles, grants and assignments.

**Roles and grants.** A role is a name with grants. A grant is a permission, with an optional
relation, field set and resource pattern. A string is shorthand for `{ permission }`.

```ts
authz: {
  rbac: {
    roles: {
      guest:  { grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['Login'] } }] },
      user:   { grants: [
        { permission: 'user:read',   relation: 'self',  fields: { read: ['Email', 'Login'] } },
        { permission: 'user:update', relation: 'self',  fields: { write: ['Email', 'Password'] } },
        { permission: 'Task:read',   relation: 'owner' },
        { permission: 'Task:update', relation: 'owner' },
      ] },
      'admin.users': { assignable: false, grants: ['users:create', 'users:read', 'users:update', 'users:delete'] },
      admin:  { extends: ['admin.users'], grants: ['user:impersonate'] },
      'org.admin': { scopeTypes: ['org'], grants: ['project:read', 'project:update'] },
    },
    anonymousRoles: ['guest'],
    serviceRoles: { 'service:telemetry': ['telemetry'] },
    cache: { assignmentsTtlSeconds: 60, rolesCheckSeconds: 60 },
  },
}
```

- **`extends`** inherits the grants of other roles, through a graph. A cycle or an unknown role fails
  boot (B12).
- **`assignable: false`** marks a role that exists only to be extended. An assignment to it is refused
  (`not_assignable`). Roles that package configs define for this purpose use it.
- **`scopeTypes`** limits where a role may be assigned. `org.admin` above can sit at `org:7` and
  nowhere else (B13).
- **`relation`** turns the grant into a condition on the row. `owner` means the row's owner column
  holds the principal. `self` means the row is the principal's own account. Other relations come from
  `@OrmScope` classes. Several relations on one grant are OR-ed (B15).
- **`fields`** are field globs for read or write. `['*', '!Password']` works. A grant without
  `fields` allows every field before `neverRead` applies.
- **Union of roles (H1).** A principal's effective permissions are the union of the grants of all
  its live assignments. A session role switch only narrows: it sets `ceiling.roles`, which keeps the
  assignments of the listed roles and drops the rest (B11, B24). `ceiling.roles` lists assigned
  role names. It does not follow `extends`, and it takes no globs.
- **Per-scope roles (H10).** An assignment is subject × role × scope. An assignment at `org:7` applies
  to `org:7` and to every resource whose ancestors contain it (B13). Role definitions are global
  (H14): `org.admin` means the same in every org. Who holds it, and where, differs.
- **Expiry.** Expired assignments contribute nothing, and `decision.validUntil` is the earliest
  expiry among the contributors (B14).
- **Subjects.** The model reads assignments for the principal, its companions and the subject sets it
  belongs to. A subject set is "every holder of role R at scope S" (B33).

`RbacService` offers `rolesOf(principal, at)`, `grantsOf(role)` and `covers(…)`.

> **TODO(L1b):** ladders (ranked roles), implied roles, tags, provenance, rules (`restrict`, `cap`,
> `threshold`) and share links. The design fixes the shapes (§6.1.1, §8.2, §8.5). Fill in the config
> keys and samples from the L1b report when the lane merges.

> **TODO(L2):** the stores that read `authz.rbac.roles` from config and assignments from the database
> (`ConfigRoleStore`, `DbAssignmentStore`), the migrations (`authz_assignment` and the others), the
> `users.Role` copy and drop, the CLI commands `authz:assign`, `authz:revoke` and `authz:check-config`,
> and how an app registers the RBAC model. Fill in from the L2 report.

## The ABAC model

`@spinajs/authz-abac` holds policies. A policy permits or denies a set of permissions when a
condition holds. A deny beats an RBAC permit under `deny-overrides` (B18).

```ts
authz: {
  abac: {
    policies: [
      { id: 'mfa-admin-writes', effect: 'deny', permissions: ['users:update', 'users:delete'],
        when: { not: { attr: 'principal.authn.assurance', eq: 'aal2' } }, reason: 'mfa_required' },
      { id: 'protected-metadata', effect: 'deny', permissions: ['user.metadata:update', 'user.metadata:delete'],
        when: { attr: 'resource.Key', glob: 'security.*' }, reason: 'protected_key' },
      { id: 'agents-office-hours', effect: 'deny', actorTypes: ['agent'], permissions: ['*'],
        when: { not: { fn: 'time.between', args: { from: '08:00', to: '18:00', tz: 'Europe/Warsaw' } } } },
      { id: 'pool-campaigns', effect: 'permit', permissions: ['ArrowCampaign:read'],
        when: { attr: 'resource.platform_type', eq: { ref: 'principal.attributes.pool' } } },
    ],
    stores: ['ConfigPolicyStore'],   // add 'DbPolicyStore' for policies written through AuthzAdmin
  },
}
```

A policy has `id`, `effect`, `permissions` (globs), and optional `resourceTypes`, `principalTypes`,
`actorTypes`, `scope` (applies at this node and below), `when`, `fields`, `reason`, `priority`
(default 500) and `expiresAt`.

**Conditions** are a JSON tree and live in the core:

- `{ all: […] }`, `{ any: […] }`, `{ not: … }`.
- `{ attr, <op>: value }` with `attr` one of `principal.*`, `actor.*`, `resource.*`, `env.*`,
  `scope.<type>.*`. Ops: `eq ne in nin lt lte gt gte like glob wildcard null`. A value may be
  `{ ref: '…' }`.
- `{ fn, args }` calls a named function: `time.between`, `ip.in`, `glob`, `wildcard`.

Rules that matter:

- `principal.*`, `actor.*`, `env.*` and `scope.*` are bound at once. `resource.*` becomes a residual on
  the row.
- A missing attribute makes the condition UNKNOWN, and the policy fails closed. A deny on
  `dept eq 'ops'` also denies a principal that has no `dept`. To deny only ops, write
  `{ attr: 'principal.attributes.dept', null: false }` next to it.
- `eq: null` and `ne: null` are refused. Use `{ attr, null: true }` or `{ attr, null: false }`.
- A deny policy that needs the row, when no row is given, denies with `needs_subject`. A permit that
  needs the row permits nothing.
- A deny policy with `fields` also denies. It does not only hide the fields.
- `actorTypes` matches the acting principal (`req.actor`, else the principal). Under `inherit`
  delegation the models see the delegate as the principal and the agent as the actor.

Config keys: `authz.abac.policies`, `authz.abac.stores`, `authz.abac.connection` (default
`default`). Policy writes go through `AuthzAdmin` (`policy.put`, `policy.delete`).

> **TODO(host wiring, no lane named):** nothing registers `AbacModel` in DI. An app constructs
> `new AbacModel()`, registers it as `AuthorizationModel`, and registers
> `new AbacContributor(model)` as `AuthzContributor`. Replace this note when a lane wires it.

## Adapters

An adapter connects the engine to a kind of resource: it names the type of an object, supplies
ancestors and relations, and applies a residual.

### HTTP (`@spinajs/authz-http`)

```ts
import { Access, AllowAnonymous, Unscoped, fromModel, fromParam, CurrentPrincipal } from '@spinajs/authz-http';

export class Campaigns extends BaseController {
  @Get('/')
  @Access('ArrowCampaign:read')
  list() {}

  @Put(':campaign')
  @Access('ArrowCampaign:update', { resource: fromModel(ArrowCampaign, 'campaign'), fields: 'filter' })
  update(@FromModel() campaign: ArrowCampaign) {}

  @Get('public/:id')
  @AllowAnonymous()
  @Access('Page:read', { resource: fromParam('id', 'Page') })
  page() {}
}
```

- `@Access(permission | permission[], opts)`: several permissions mean any of them. Class and route
  `@Access` combine with AND (L5). A subclass `@Access` replaces the inherited one.
- Options: `resource` (an extractor: `fromParam`, `fromBody`, `fromQuery`, `fromModel`), `also` (more
  policies in the same AND group), `domain`, `subject` (`'load'` loads the row for a definite answer),
  `fields` (`'filter'` limits the response to `decision.fields.read`).
- No principal and no `@AllowAnonymous`: 401. A denial: 403 with
  `{ error: 'forbidden', permission, resource, reason }` (B23).
- `@Unscoped(reason)` tells the ORM adapter to skip the residual for this route. The principal stays
  and the call is audited once. A route with `@Unscoped` and no `@Access` fails registration.
- Body fields are limited to `decision.fields.write` minus `neverRead`: stripped, or a 400 in
  `reject` mode. `@UnfilteredInput(reason)` opts a route out. See `packages/authz-http/README.md`.
- Principal sources run in order: `ServicePrincipalSource` (40), `AuthnPrincipalSource` (50, the
  principal `authn-http` left in `req.storage.AuthnPrincipal`), `LinkPrincipalSource` (110).
- `GET /user/access` returns the access summary. `POST /user/access/check` checks up to 100
  permissions. `GET /authz/explain` exists only when `authz.http.explainRoute.enabled` is true and
  never in production (H19, B41).

```ts
authz: {
  http: {
    services: [{ name: 'telemetry', header: 'x-telemetry-key', token: ['…'] }],   // header-token service principals
    links: { query: 'link', header: 'X-Authz-Link', cookie: null },
    explainRoute: { enabled: false, permission: 'authz:explain' },
    access: { domain: 'root' },        // the domain /user/access and the explain route answer for
  },
}
```

> **TODO(L5 follow-up):** a share link token opens a dead link until an app registers a `LinkResolver`
> (L5 hand-off). Document the registration once the RBAC link store merges (L1b, L2).

### ORM

> **TODO(L4):** `@AccessResource`, `@Owner`, `@ScopeColumn`, `@OrmScope` with `OrmScopePolicy`, query
> scoping, field filtering helpers, `DbDecisionAudit`, and how an app turns it on. The design fixes
> the behaviour: a select, update or delete on an `@AccessResource` model gets the residual as a
> WHERE clause; a `FALSE` residual throws `AccessDenied`; an insert stamps the `@Owner` column or
> asks the `OrmScopePolicy`; a model without `@AccessResource` is never checked (B20, B21). Fill in
> the decorators and samples from the L4 report.
>
> **TODO(L4b):** RBAC rules compiled to SQL for lists (B44).

### Queue

> **TODO(L6):** `Initiator` stamping on emitted messages, `@Job({ runAs })`, the queue-backed
> `ChangeBus`. The design fixes the behaviour: a handler runs as the initiator, as system or
> unattended, and unattended is the default (B30, B09). Fill in from the L6 report.

### File system

> **TODO(L7):** `authz.fs.<name>` config, the guarded file system, `fs:*` permissions and the
> `fs` domain. The design fixes the behaviour: a file system with no `authz.fs` entry, or with
> `mode: 'off'`, is the raw provider (H9, B28). Fill in from the L7 report.

## AuthzAdmin

Every write of authz data goes through one service, `AuthzAdmin`. No app writes `authz_*` tables
directly (H22, B43). It is a command bus: validation, the actor's permission, a guard, one
transaction per batch, a version bump, cache invalidation, events and audit.

```ts
import { DI } from '@spinajs/di';
import { AuthzAdmin } from '@spinajs/authz';

const admin = await DI.resolve(AuthzAdmin);

// sugar for one command
await admin.assign(actor, { subject: { type: 'user', id: '42' }, role: 'org.admin', scope: { type: 'org', id: '7' } });
await admin.revoke(actor, assignmentId);

// a batch: all or nothing
const results = await admin.execute(actor, [
  { kind: 'set.addMember', set: { role: 'group.member', scope: { type: 'group', id: 'G' } }, member: { type: 'user', id: '42' } },
  { kind: 'assignment.setExpiry', id: assignmentId, expiresAt: null },
], { reason: 'onboarding', idempotencyKey: 'req-123' });
```

**Commands.** `assignment.grant`, `assignment.revoke`, `assignment.revokeWhere`,
`assignment.setTags` / `addTags` / `removeTags`, `assignment.setExpiry`, `set.addMember`,
`set.removeMember`, `link.create`, `link.update`, `link.revoke`, `rule.put`, `rule.delete`,
`policy.put`, `policy.delete`, `scope.setAttributes`, `scope.replaceAttributes`, `scope.forget`.
`list(actor, query)` reads for admin UIs.

**One command goes through** (pipeline refined by L9):

1. Validate and run the app's `AuthzCommandValidator`s (roles exist and are assignable at the scope,
   rules and policies compile, attribute patches match the schema).
2. Check that the actor holds the command's permission at the command's scope.
3. In one transaction: run the `AdminGuard`, apply the commands, bump `authz_version`.
4. After the commit: publish `AuthzChange` (caches drop their entries), send events to the
   `AuthzEventSink`s and write one audit entry per command.

A failed batch applies nothing, publishes nothing and reports the first failure with its index. A
retried batch with the same `idempotencyKey` returns the first result (the key is scoped to domain,
actor and key, and kept for 24 hours). A `link.create` token appears only in the command result,
never in events or audit. `dryRun: true` validates and guards, then rolls back.

**The permission** a command needs defaults to `authz:assignments.manage`, `authz:links.manage`,
`authz:rules.manage`, `authz:policies.manage`, `authz:scope.manage` or `authz:scope.forget`, at the
command's scope. The core registers none of these names. Declare them in `authz.permissions`, or
map each command to your own permission with `authz.admin.permissions`.

**The guard** (`DefaultAdminGuard`, in `@spinajs/authz-rbac`) refuses these (error codes in
brackets):

- granting a role the actor does not cover at that scope (`escalation`);
- an actor removing its own access (`self_lockout`);
- removing the last holder of the privileged permission at `$global` (`last_holder`);
- changing a system role: with `protectSystemRole`, a role with `assignable: false` is a system role,
  and only `SYSTEM` may change its rows (`protected_role`).

`SYSTEM` skips the guard and is audited. A missing guard fails closed: every call throws
`AuthzConfigError` until `authz.admin.guard.service` names a registered guard.

```ts
authz: {
  admin: {
    guard: {
      service: 'DefaultAdminGuard',          // authz-rbac ships these defaults
      privilegedPermission: 'users:update',
      protectSystemRole: true,
      preventEscalation: true,
      preventSelfLockout: true,
      preventLastPrivilegedRemoval: true,
    },
    permissions: { 'assignment.*': { project: 'grants:manage' } },   // by command kind, family or scope type
    maxBatch: 100,
    backend: 'DbAuthzAdminBackend',          // default: MemoryAuthzAdminBackend (no database)
    connection: 'default',                   // ORM connection of the DB backend
  },
}
```

`DbAuthzAdminBackend` (in `@spinajs/authz-rbac`) runs each batch in its own ORM transaction, with a
per-domain lock on the `authz_version` row. It refuses to run inside an open transaction. The
default backend keeps data in memory.

**Events.** Events go to every `AuthzEventSink` after the commit. The queue sink sends
`RoleAssigned`, `RoleRevoked` and `AuthzDataChanged` (replacing the 2.x `UserRoleGranted` and
`UserRoleRevoked`).

> **TODO(L2):** the DB stores for assignments, links and rules that `DbAuthzAdminBackend` writes to,
> and the migration names. Fill in from the L2 report.
>
> **TODO(C4):** the `/authz/commands` and `/authz/assignments` routes of `authz-http-admin`.
>
> **TODO(L6):** `QueueAuthzEventSink`.

## Testing kit

`@spinajs/authz-testing` holds what you need to test a model, an adapter or an app.

- `runModelConformance(name, factory, opts)` and `runAdapterConformance`: checks a model or adapter
  against the contract (capabilities, sync claims, residual against concrete answers, cache keys).
- `runBehaviour(ids, harnessFactory, opts)`: runs the behaviour fixtures B01-B46.
- `hostHarness`: boots a real host with your models in a test, in the root domain or a child domain.
- Fakes: `FakeRbacModel`, `FakeTupleModel`, `FakeAdapter`, `FakeScopeResolver`, `RecordingAudit`,
  `RecordingChangeBus`, `ManualClock`, principal builders, fast-check arbitraries.

Read `packages/authz-testing/README.md` ("Writing a harness" and "DI rules for harness writers")
before you write a harness. For a model you write yourself, `packages/authz/README.md` has the model
guide: throw instead of voting "no" on missing data, key every cache on everything the answer
depends on, and declare honest capabilities.
