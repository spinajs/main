# Authorization in SpinaJS 3.0

`@spinajs/authz` answers one question: may this principal do this action on this resource?
It replaces the 2.x `rbac` authorization code (`accesscontrol`, `@Permission`, `RbacPolicy`).

- Moving a 2.x app: read [the migration guide](./migration-guide.md).
- Authentication (who is calling) is a separate family: [docs/authn](../authn/README.md).
- Rule numbers such as B11 or H1 point to the design:
  `docs/plans/2026-10-01-authz-v3-design.md` (§17 for B-rules, §3.1 for H-decisions).
- The package READMEs of `authz-orm`, `authz-queue`, `authz-fs` and `authz-http-admin` hold their
  full detail. The READMEs of `authz-rbac` and `authz-abac` are stubs, so this page is their
  reference. It describes `3.0.0-rc.1`. What is still open is listed in
  [the migration guide, section 11](./migration-guide.md#11-open-items-in-300-rc1).

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

**`covers` and `summary` (E1).** Both count what each model lists in its `summarize` answer, so a
scoped, bare-type or pattern-limited grant counts too (RFC L1-3).

- The target's set is its own checks plus every summary entry of the models routed for the
  permission. At `$global`, holder and target are compared on `$global` and on each type of the
  permission. The holder's set is its checks only, never a summary.
- A summary entry counts as covered only when the holder is unconditional on every compared
  resource and has the entry's fields. The holder's fields come from unconditional permits only.
- A deny on the target never drops its summary entries, because a deny may rest on session facts
  that change under impersonation.
- `covers` is false, never a guess, when a routed model gives no summary for the target (no
  `summarize`, a failure, a timeout or a malformed answer) and when any compared plan uses a custom
  combinator. **A model you write must implement `summarize`**, or `covers` stays false in every
  domain that routes it. The test kit's `FakeTupleModel` has `summarize` since K4.
- `summary` shows a name that a model's summary lists but the check denies as `conditional: true`.
  Its fields are the union over the entries, less `neverRead`.
- `covers` costs up to 2 × (1 + number of types) checks per permission at `$global`, and its holder
  checks skip the cache. The call's deadline still bounds it.
- The ABAC and RBAC `summarize` answers list scoped permits as conditional, and union the fields of
  every permit they find. An ABAC permit that reads env, time, `actor.*`, `principal.authn.*` or a
  function is listed as conditional.
- `covers` judges one instant, with the target object you give it. Build the target the way the
  session will carry it: no strategy attributes, no ceiling, the companions and the actor the
  session will have.

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
      roleSwitch: { requirePassword: ['admin'] },  // roles a role switch asks the password for; unset: all; [] turns the check off
    },
    fields: { neverRead: ['Password'], write: { mode: 'strip' } },   // 'strip' | 'reject'
    engine: { explain: false, modelTimeoutMs: 2000, maxDelegation: 2 },
    cache: { maxEntries: 10000, ttlSeconds: 60 },  // maxEntries 0: no L2; ttlSeconds 0: no L1 either
    audit: { denials: true, runAs: true, unscoped: true },
    config: { rejectLegacyKeys: true },            // false: an rbac.* key only warns
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
- The `authz` host does not read the 2.x `rbac.*` keys. By default boot fails with an error that names
  the keys and `spinajs-authz-convert`. With `authz.config.rejectLegacyKeys: false` it only warns.
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
      telemetry: { grants: ['telemetry:write'] },
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
- **`scopeTypes`** limits the scope type where a role may be assigned. `org.admin` above can sit at
  any `org:<id>` scope, and not at `$global` or at another scope type (B13).
- **`relation`** turns the grant into a condition on the row. `owner` means the row's owner column
  holds the principal. `self` means the row is the principal's own account. Other relations come from
  `@OrmScope` classes. Several relations on one grant are OR-ed (B15).


  Each relation needs a `RelationResolver` for the type, or boot fails (boot rule 8: "relation ...
  has no RelationResolver"). `@spinajs/authz-orm` supplies `owner` for every `@AccessResource`
  model with an `@Owner()` column, and one resolver per `@OrmScope` relation. `@spinajs/users`
  supplies `self` on `user`. `ownsBy(type, relation, fn)` (authz-orm) builds an in-memory resolver
  with no SQL form; register it in the domain before it boots. See [ORM](#orm-spinajsauthz-orm).
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

**Ladders, tags, rules and links.** No 2.x app needs these; canvas does. Design §8.5 holds a full
config, and §6.1 the rules behind it.

```ts
authz: {
  rbac: {
    ladders: { project: { roles: ['viewer', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] } },
    roles: {
      viewer:     { ladder: 'project', grants: ['project:read', { permission: 'code:view', requiresTag: 'code' }] },
      editor:     { ladder: 'project', grants: ['file:edit', { permission: 'branch:create', grantedAt: ['project'] }] },
      maintainer: { ladder: 'project', grants: ['project:settings'] },
      'org.admin': { scopeTypes: ['org'], grants: ['org:manage'],
                     implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['code'], bypass: ['restrict', 'cap'] }] },
      'group.member': { subjectSet: true, grants: [] },
    },
    rules: [
      { id: 'file-grant-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } },
      { id: 'no-download', kind: 'threshold', permissions: ['project:export'], minRole: 'editor',
        when: { attr: 'scope.org.policies.viewers_may_download', eq: false }, reason: { code: 'policy' } },
    ],
    stores: { rules: ['ConfigRuleStore', 'DbRuleStore'] },
  },
}
```

- **Ladders.** A ladder orders roles from low to high. A ladder role holds the grants of every lower
  role, and the effective role per ladder is the highest live one after rules apply (B31). Ladder
  grants apply only to the ladder's `resourceTypes`.
- **Tags and provenance.** `requiresTag` makes a grant count only when the assignment carries the tag
  (`tag_missing` otherwise). `grantedAt` limits a grant to roles held at those scope types
  (`provenance` otherwise).
- **`implies`** gives a role at a scope another role at that scope (`self-and-descendants`) or below
  it (`descendants`), with tags, and may bypass `restrict` and `cap` rules.
- **Subject sets.** A `subjectSet` role names "every holder of this role at this scope", so an
  assignment can go to a group (`{ set: { role: 'group.member', scope: { type: 'group', id: 'G' } } }`).
  `authz.rbac.groupPrincipal` (default `{ role: 'group.member', scopeType: 'group' }`, `null` turns it
  off) says which set a `group` principal speaks for.
- **Rules only narrow.** `restrict` drops the assignments made strictly above its scope unless their
  subject is in `allow`, so only the listed subjects keep inherited access there. `cap`
  limits the ladder role (`maxRole`, a role or `{ ref }` to a scope attribute; `null` drops the
  assignment) or strips tags (`stripTags`). `threshold` asks a minimum role for some permissions,
  with its own `reason`. Each rule may filter by `scope`, `resourceTypes`, `subjects`
  (`principalTypes`, `actorTypes`, `refs`, `rank`) and `when`, and may carry `expiresAt` (a `Date`, or a
  date-time string with a zone; one without a zone fails boot).
- **Rule stores.** `ConfigRuleStore` reads `authz.rbac.rules`; `DbRuleStore` holds rules written through
  `AuthzAdmin` (`rule.put`). The RBAC model reads at most one of each. Rules in config with no
  `ConfigRuleStore` named fail boot, so they are never dropped without a word.
- **Share links.** `AuthzAdmin` creates a link (`link.create`) and returns its token once. A request
  that carries the token (query `link` or header `X-Authz-Link`, `authz.http.links`) runs as a `link`
  principal with a ceiling of the link's scope and expiry; the signed-in user, if any, is its
  companion (B38). Bind the resolver as shown in [Wiring the models](#wiring-the-models), or every
  link opens a dead link (`link_invalid`).

**Stores.** The model reads roles, assignments, rules and links through four ports. You name the
classes in `authz.rbac.stores`. The defaults live in code, not in a config file, so you can replace
them:

```ts
authz: {
  rbac: {
    stores: {
      roles: ['ConfigRoleStore'],          // authz.rbac.roles from config
      assignments: ['DbAssignmentStore'],  // table authz_assignment
      rules: ['ConfigRuleStore', 'DbRuleStore'],   // default ['ConfigRuleStore']; [] turns rules off
      links: ['DbLinkStore'],              // table authz_link
    },
    connection: 'default',                 // else authz.admin.connection, else the default connection
    links: { secret: '<32 or more characters>' },   // no default
    cache: { assignmentsTtlSeconds: 60 },
    migration: { idColumn: 'Uuid', roleColumn: 'Role' },   // migration guide, section 7
  },
}
```

- `ConfigRoleStore` checks `authz.rbac.roles` and `ladders` when it loads. A bad key fails boot with
  an `AuthzConfigError` that names it.
- `DbAssignmentStore` and `DbLinkStore` read and write `authz_assignment` and `authz_link`. A write
  runs only inside the transaction of `DbAuthzAdminBackend` ([AuthzAdmin](#authzadmin)) and bumps
  `authz_version` there. Granting the same subject, role and scope again updates the row and keeps
  its id, `created_at` and `source`.
- `DbRuleStore` keeps scoped rules in `authz_rule`, each with a SQL form, so a list query can filter
  in the database. It refuses a rule it cannot compile exactly (`rule_not_compilable`): permission
  globs other than `*`, the ops `in`, `nin` and `pattern` in `when`, numeric strings, and order ops on
  values that are not numbers. So the SQL is never wider than the evaluator.
- **Share link tokens.** A token is 32 random bytes in base64url. The table keeps only `v1:` and an
  HMAC-SHA256 of the token under `authz.rbac.links.secret`, which needs at least 32 characters. The
  store checks the key at first use, not at boot, and throws `AuthzConfigError` when it is missing.
  Changing the secret kills every link.
- **Connections.** The stores use `authz.rbac.connection`, else `authz.admin.connection`, else the
  `default` connection. A write whose transaction runs on another connection is refused. The
  migrations run on `default` only.
- **Registering.** A store class registers under its class name only.
  `registerRbacStores(container, configuration)` registers the classes that `authz.rbac.stores`
  names under their ports (`RoleStore`, `AssignmentStore`, `RuleStore`, `LinkStore`) and, for the DB
  stores, under the `AuthzAdmin` ports too. A name that is no registered class, or the wrong kind,
  throws `AuthzConfigError` and registers nothing.

**Tables.** The migration `AuthzRbac_2026_10_01_00_00_00` creates `authz_assignment`, `authz_rule`,
`authz_rule_subject`, `authz_link` and `authz_version`. `authz_rule` has eight columns that the
design's DDL lacks: `principal_types`, `rank_ladder`, `rank_at`, `rank_min`, `rank_max`,
`resource_not_like`, `resource_glob` and `resource_not_glob`. The `users.Role` copy and drop are two
more migrations, described in [the migration guide](./migration-guide.md#7-data-migration).

**CLI.** `@spinajs/authz-rbac` ships four commands. They run as `SYSTEM` with the reason `cli`. On
failure they print one line and set the exit code to 1.

| Command | Does |
|---|---|
| `authz:assign <subject> <role> [-s <scope>] [-e <iso>] [-t <tags>]` | Assigns a role through `AuthzAdmin`. `subject` and `scope` are `<type>:<id>`; the scope defaults to global. `-e` is a future ISO 8601 date, or a date-time with a zone. It prints the assignment id. |
| `authz:revoke <subject> <role> [-s <scope>]`, or `authz:revoke --id <id>` | Revokes every match of subject, role and scope, or one assignment by id. It fails when nothing matches. |
| `authz:explain <principal> <permission> [<resource>] [--json]` | Prints the decision, its reason, the roles, the fields and the trace. |
| `authz:check-config [--explain-role <role>] [--unattended]` | Boots the authz service, loads the role stores and prints `OK: <n> role(s), <m> ladder(s)`. `--explain-role` lists the effective grants of a role. It needs `RbacService` registered in the root container (the app's `registerRbac(DI.RootContainer, …)` call, see [Wiring the models](#wiring-the-models)) and fails with "the RBAC model ... is not registered" otherwise. `--unattended` counts the rows of `authz_audit` with the reason `unattended`, by resource type. It needs the `authz_audit` table of `DbDecisionAudit` and reads it on `authz.rbac.connection` (else `default`), so map `DbDecisionAudit`'s `authz-audit` connection to the same database ([ORM](#orm-spinajsauthz-orm)). |

### Wiring the models

No package registers the RBAC or ABAC model for you. The app wires them in the container of the
domain, before the domain's `AuthzService` first resolves (at boot, after `Configuration`):

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import { registerRbac } from '@spinajs/authz-rbac';
import { AbacModel, AbacContributor, ConfigPolicyStore, DbPolicyStore, PolicyStore } from '@spinajs/authz-abac';
import { LinkResolver } from '@spinajs/authz-http';
import { Orm } from '@spinajs/orm';

const configuration = await DI.resolve(Configuration);
const rbac = await registerRbac(DI.RootContainer, configuration);   // stores, RbacModel, contributor, RbacService
DI.register(() => rbac.linkResolver).as(LinkResolver);              // share links; without it a link opens nothing

// ABAC. Policies written through AuthzAdmin need one writable store, registered as PolicyStore too.
const written = new DbPolicyStore(async () => (await DI.resolve(Orm)).Connections.get('default')!);
const abac = new AbacModel({ stores: [new ConfigPolicyStore(configuration.get('authz.abac.policies') ?? []), written] });
DI.register(() => abac).as(AuthorizationModel);
const abacContributor = new AbacContributor(abac);
DI.register(() => abacContributor).as(AuthzContributor);
DI.register(() => written).as(PolicyStore);
```

`new AbacModel()` without `stores` builds the stores `authz.abac.stores` names, but registers none of
them as `PolicyStore`, so `policy.put` and `policy.delete` then fail with `AuthzConfigError`. An app that
keeps policies in config only may use it that way.

`registerRbac(container, configuration)` registers the stores that `authz.rbac.stores` names (through
`registerRbacStores`), an `RbacModel` over them as an `AuthorizationModel`, its `RbacContributor` and an
`RbacService` (also under the name `RbacService`, which the CLI's `--explain-role` resolves). It needs
one roles store and one assignments store, at most one links store, and at most one in-memory and one
other rules store; anything else throws `AuthzConfigError` before it registers anything.

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

Config keys: `authz.abac.policies`, `authz.abac.stores` (`ConfigPolicyStore`, `DbPolicyStore`),
`authz.abac.connection` (default `default`) and `authz.abac.scopeResiduals` (default `false`). Policy
writes go through `AuthzAdmin` (`policy.put`, `policy.delete`). The app registers the model itself
([Wiring the models](#wiring-the-models)).

**`scopeResiduals`.** Off, a policy that compares `scope.<type>.*` on a list (a request without an id)
cannot decide it: a deny then denies the whole list with `needs_subject` (B19), and a permit makes the
ABAC vote indeterminate, which also denies the list under `deny-overrides` (B39). On, the comparison
becomes a residual leaf (`native:condition.scope`) that authz-rbac compiles to SQL, so the list is
filtered row by row. A list through authz-orm with the switch on needs `@spinajs/authz-rbac` loaded.
The host should also register an `RbacScopeAttributeSource` with the engine's own scope attribute
schemas; without one, an attribute that only a schema default holds refuses the row. Canvas turns it on; see `packages/authz-orm/README.md`
("ABAC scope leaves").

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
- A request with no principal is always 401. `@AllowAnonymous` only admits an anonymous (not
  authenticated) principal; it does not admit a missing one. A denial: 403 with
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

A share link token opens a dead link (`link_invalid`) until the app registers a `LinkResolver`
([Wiring the models](#wiring-the-models)).

### ORM (`@spinajs/authz-orm`)

```ts
import '@spinajs/authz-orm';
import { AccessResource, Owner, ScopeColumn, OrmScope, OrmScopePolicy } from '@spinajs/authz-orm';

@AccessResource('Task')
export class Task extends ModelBase {
  @Owner() public owner_id: string;
  @ScopeColumn('project_id', 'project') public project_id: number;
}

@OrmScope(Task, 'team')
export class TaskTeamPolicy extends OrmScopePolicy<Task> {
  scope(q: IWhereBuilder<Task>, p: Principal) { q.where('team', p.attributes.team as string); }
}
```

- Importing the package registers the adapter for every `@AccessResource` type and the query
  middleware. Register models before the authz domain boots (at import, or in a `Bootstrapper`); a type
  registered later makes every check on it throw `AuthzConfigError` until the domain boots again.
  `registerAccessResource(model, type)` marks a model a package does not own.
- A select, update or delete on an `@AccessResource` model gets the residual as a WHERE clause. A
  `FALSE` residual throws `AccessDenied`, and so does any query without a principal (`UNATTENDED`). An
  insert stamps the `@Owner` column or asks the policy's `authorizeCreate`; an update under a relation
  asks `authorizeUpdate`. A model without `@AccessResource` is never checked (B20, B21).
- `runAs(SYSTEM, reason, fn)` and a route's `@Unscoped(reason)` run unscoped, audited.
- RBAC rules compile to SQL for lists (B44): `native:rbac.assignment` with the rules of the path, so a
  list of a ladder-scoped type is filtered in the database. Rules over the stored rule tables need
  PostgreSQL 12 or SQLite 3.35 or later (`WITH … AS MATERIALIZED`). On SQLite such lists suit small tables
  only. **On PostgreSQL, authz-orm refuses a connection that runs with `jit = on`** (the server
  default): turn it off for the app's role or database (`ALTER ROLE … SET jit = off`), or set
  `authz.orm.allowJit: true` to accept slow lists.
- **Performance.** On PostgreSQL the rule terms of a list are mostly worked out once per class of rows
  (rows that share their scope path and rule inputs), then applied to each row; SQLite keeps one
  evaluation per row, and so does PostgreSQL for a config threshold reading `resource.*` or a scope
  column without an id mode. Each class term reads the whole model table once per statement, so its
  cost grows with the table, also when the app's own WHERE keeps few rows. A stored rule whose definition PostgreSQL cannot parse
  fails every list of that model. Measured for release gate 7 (still open: the limits are being
  rethought by the owner), canvas `file:read` over 1,000 files on PostgreSQL 16 with `jit = off`: the
  list p50 90 to 182 ms, a 50-row page p50 90 to 128 ms and p99 133 to 189 ms; with other tenants'
  rows in the tables, lists 94 to 201 ms and pages 95 to 174 ms. A page spends 23 to 36 ms compiling the
  statement and 12 to 23 ms planning it. Full numbers: `packages/authz-rbac/bench/RESULTS.md`.
- `filterFields(decision, data, mode)` keeps the fields the decision allows. `DbDecisionAudit`
  (`@spinajs/authz-orm/audit`) writes audit records to `authz_audit` on the connection named
  `authz-audit`.
- What the middleware cannot see (raw SQL, views, DDL), relations, clones and the native compiler
  helpers: `packages/authz-orm/README.md`.

### Queue (`@spinajs/authz-queue`)

- Importing the package stamps `message.Initiator` on every emit from the current principal. It
  stamps nothing for an unattended, delegated or impersonating principal, or a forged `system` one.
- A handler runs as `UNATTENDED` unless its job says `@Job({ runAs: 'initiator' })` (the principal that
  emitted it, rebuilt from the stamp) or `@Job({ runAs: 'system' })` (B30, B09). Every run is wrapped in
  `runAs` with the reason `job:<name>`.
- The import also registers `QueueChangeBus` as the default `ChangeBus` of every domain without
  `authz.bus.service`, registers `JobModel` as the `job` resource with the relation `initiator`, and
  grants `job:read` (relation `initiator`) to the `user` role. Install without import adds nothing.
- The default `InitiatorPrincipalFactory` builds the principal from the stamp alone and warns once.
  `@spinajs/users/queue` registers one that reloads the user. See `packages/authz-queue/README.md`.

### File system (`@spinajs/authz-fs`)

- A file system with no `authz.fs.<name>` entry, or with `mode: 'off'`, is the raw provider (H9, B28).
  `mode: 'enforce'` checks `fs:read`, `fs:stat`, `fs:list`, `fs:write`, `fs:delete` or `fs:share` on
  every path and throws `AccessDenied`; `mode: 'audit'` checks, warns and goes on.
- A path is the resource `{ type: 'file' | 'dir', id: '<fs name>:<path>' }`; its ancestors are the
  parent directories, then `{ type: 'fs', id: <fs name> }`.
- Import the package before `fsService` resolves, and take providers after it resolved.
- Owners (`metadata`, `stampOwner`), signed URLs, uploads, `fromFsPath`, the `fs` domain with
  `fs-inherit` and `fs-abac`: `packages/authz-fs/README.md`. authz-fs builds the `fs-abac` model itself, in
  the filesystem's own domain and only when that filesystem has `policies`; list it in that domain's
  `combine`.

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
- an actor removing its own access to the privileged permission (`self_lockout`; it checks only
  `privilegedPermission`, not the actor's other access);
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

**Events.** Events such as `RoleAssigned` and `RoleRevoked` (which replace the 2.x `UserRoleGranted`
and `UserRoleRevoked`) go to every `AuthzEventSink` after the commit. Only `LogAuthzEventSink` ships:
3.0 has no queue sink, so an app that needs the events on its queue registers its own
`AuthzEventSink`.

`DbAuthzAdminBackend` writes through `DbAssignmentStore`, `DbRuleStore` and `DbLinkStore` (see
[the RBAC model](#the-rbac-model)). Their tables come from `AuthzRbac_2026_10_01_00_00_00`. The
backend's table of idempotency keys comes from `AuthzAdminIdempotency_2026_10_02_00_01_00`. An admin
batch bumps `authz_version` more than once, in one transaction; do not rely on the count.

**HTTP routes.** `@spinajs/authz-http-admin` serves `AuthzAdmin` over HTTP: `POST /authz/commands` and
routes under `/authz/assignments`, `/authz/links`, `/authz/rules`, `/authz/policies` and
`/authz/scopes/:type/:id/attributes`. The routes only check that the caller is signed in; the caller
is the actor, so every permission and guard check runs inside `AuthzAdmin`. **An app with the package
installed serves these routes** (`authz.http.admin.domain`, default `root`, picks the domain). Encodings
and status codes: `packages/authz-http-admin/README.md`.

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
