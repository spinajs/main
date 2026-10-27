# Database storage

The database stores (`DbAssignmentStore`, `DbMembershipStore`, `DbRuleStore`, `DbLinkStore`) and `DbAuthzAdminBackend` read and write the RBAC tables through ORM records. Every record and every migration lives on the ORM connection alias `authz`, which the app maps to a connection with `db.Aliases.authz`.

Use it for any app that keeps assignments, links or stored rules in a database. Role definitions stay in config (`ConfigRoleStore`).

## How it works

### Reads

1. `RbacModel.init` (through `rbacStoreOptions`) calls `registerRbacStores`, which registers the classes `authz.rbac.stores.*` names under their ports (`AssignmentStore`, `MembershipStore`, `RuleStore`, `LinkStore`) and, for the DB stores, under the `AuthzAdmin` ports (`AdminAssignmentStore`, `AdminMembershipStore`, `AdminRuleStore`, `AdminLinkStore`).
2. Every DB store injects the `Orm` (`@Autoinject(Orm)`), so resolving a store from the domain's container resolves the `Orm` and binds the records, also in a CLI process that boots only its command.
3. The store queries its record (`AssignmentRecord.query()...`). The record is bound to `authz`, so the query runs on the connection `db.Aliases.authz` names.
4. A read of live rows keeps `expires_at IS NULL OR expires_at > ?`, with the `AuthzClock` instant of the store's container bound as the parameter.

### Writes

1. `AuthzAdmin` opens a batch with `DbAuthzAdminBackend.transaction(domain, fn)`.
2. The backend checks the domain name (at most 64 characters) and takes the driver of `VersionRecord`. It injects the `Orm`, so the records are bound by then.
3. It refuses to run inside an open transaction on that connection (`AuthzConfigError`).
4. It makes sure the domain's `authz_version` row exists, then opens a transaction, at `READ COMMITTED` when the driver supports it.
5. The first statement updates the domain's `authz_version` row. That row lock orders the batches of one domain; other domains do not wait.
6. Each store write calls `requireTransaction(record, tx, where)`, which accepts only the `AuthzTx` driver of an open transaction on the record's connection.
7. Each write bumps `authz_version.version` of the store's domain in the same transaction (`bumpVersion`).
8. With an `idempotencyKey`, the backend reads (`recall`) and writes (`remember`) `authz_admin_idempotency`.

```mermaid
sequenceDiagram
  participant A as AuthzAdmin
  participant B as DbAuthzAdminBackend
  participant S as DbAssignmentStore
  participant DB as authz connection
  A->>B: transaction(domain, fn)
  B->>DB: ensure authz_version row
  B->>DB: BEGIN; UPDATE authz_version (domain lock)
  B->>S: fn({ driver })
  S->>S: requireTransaction(AssignmentRecord, tx)
  S->>DB: INSERT / UPDATE authz_assignment
  S->>DB: authz_version.version += 1
  B->>DB: COMMIT
```

### Errors on the way

| Error | When |
| --- | --- |
| `AuthzConfigError` "no ORM connection answers to "authz"; set db.Aliases.authz" | The alias maps to no connection. |
| `AuthzConfigError` "the Orm is not resolved yet" | A write runs before the `Orm` resolved. |
| `AuthzConfigError` "stores write only inside an AuthzAdmin transaction" | A store write outside a batch. |
| `AuthzConfigError` "the AuthzTx runs on connection X, but T is on connection Y" | The batch runs on another connection than the record. |
| `AuthzConfigError` "DbAuthzAdminBackend runs its own transaction" | `AuthzAdmin` is called inside `db.transaction()`. |
| `AuthzConfigError` "table ... does not exist; migration ... creates it" | `authz_version` or `authz_admin_idempotency` is missing. |
| `AuthzAdminFailure('conflict')` | A concurrent batch granted the same subject, role and scope, or kept changing an assignment's tags. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Aliases.authz` | `string` | `'default'` | a connection name | The connection of every authz table and migration. The package config sets the default; the app's value wins. |
| `authz.rbac.stores.assignments` | `string[]` | `['DbAssignmentStore']` | registered store class names | The assignment store. |
| `authz.rbac.stores.membership` | `string[]` | `['DbMembershipStore']` when the assignment store is `DbAssignmentStore`, else `[]` | registered store class names | The closure of subject sets. |
| `authz.rbac.stores.rules` | `string[]` | `['ConfigRuleStore']` | `ConfigRuleStore`, `DbRuleStore` | Add `DbRuleStore` for rules written through `AuthzAdmin`. |
| `authz.rbac.stores.links` | `string[]` | `['DbLinkStore']` | registered store class names | The share link store. |
| `authz.admin.backend` | `string` | `'MemoryAuthzAdminBackend'` | `DbAuthzAdminBackend`, `MemoryAuthzAdminBackend` | `DbAuthzAdminBackend` writes through the DB stores. |
| `db.StrictTableCheck` | `boolean` | `true` | `true`, `false` | The `Orm` boot fails when a registered record's table is missing. |

```ts sample
const config = {
  db: {
    Aliases: { authz: 'authz-db' },
  },
  authz: {
    rbac: {
      stores: { rules: ['ConfigRuleStore', 'DbRuleStore'] },
    },
    admin: { backend: 'DbAuthzAdminBackend' },
  },
};

export default config;
```

## Schema

Every table lives on `authz`. Datetime columns hold UTC instants and are luxon `DateTime` on the record. No table declares foreign keys.

| Record | Table | Migration |
| --- | --- | --- |
| `AssignmentRecord` | `authz_assignment` | `AuthzRbac_2026_10_01_00_00_00` |
| `MembershipRecord` | `authz_subject_membership` | `AuthzRbac_2026_10_01_00_00_00` |
| `RuleRecord` | `authz_rule` | `AuthzRbac_2026_10_01_00_00_00` |
| `RuleSubjectRecord` | `authz_rule_subject` | `AuthzRbac_2026_10_01_00_00_00` |
| `LinkRecord` | `authz_link` | `AuthzRbac_2026_10_01_00_00_00` |
| `VersionRecord` | `authz_version` | `AuthzRbac_2026_10_01_00_00_00` |
| `AdminIdempotencyRecord` | `authz_admin_idempotency` | `AuthzAdminIdempotency_2026_10_02_00_01_00` |

### `authz_assignment`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | str(36), PK | UUID of the assignment. |
| `subject_type` | str(32) | `user`, `team`, `link`, ... |
| `subject_id` | str(64) | The subject's id. |
| `subject_role` | str(128), default `''` | Empty for a principal; the set's role for a subject set. |
| `subject_key` | str(200) | `type:id` or `type:id#role`. |
| `role` | str(128) | The role assigned. |
| `scope_type` | str(64), default `$global` | Scope type. |
| `scope_id` | str(64), default `''` | Scope id. |
| `tags` | str(512), default `''` | Tags stored as `,a,b,`. |
| `expires_at` | datetime, null | Expiry; null never expires. |
| `granted_by` | str(100), null | Principal key of the actor. |
| `source` | str(32), default `db` | Where the row came from; `DbAssignmentStore` writes `db`. |
| `created_at` | datetime | Creation instant. |

Indexes: unique `authz_assignment_uq` on `(subject_type, subject_id, subject_role, role, scope_type, scope_id)`; `authz_assignment_scope` on `(scope_type, scope_id, role)`; `authz_assignment_expires` on `expires_at`; `authz_assignment_subject` on `(subject_key, role)`.

### `authz_subject_membership`

| Column | Type | Meaning |
| --- | --- | --- |
| `member_key` | str(200), PK | Subject key of the member. |
| `set_key` | str(200), PK | Subject key of the set (`type:id#role`). |
| `depth` | int | Levels between member and set. |
| `expires_at` | datetime, null | Expiry of the membership path. |

Index `authz_subject_membership_set` on `set_key`.

### `authz_rule`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | str(160), PK | Rule id. |
| `kind` | str(16) | `restrict`, `cap` or `threshold`. |
| `scope_type` | str(64), default `$global` | Scope type. |
| `scope_id` | str(64), default `''` | Scope id. |
| `definition` | text, `@Json` | The rule without id, scope and expiry. |
| `expires_at` | datetime, null | Expiry. |
| `created_by` | str(100), null | Principal key of the actor. |
| `created_at` | datetime | Creation instant. |

Index `authz_rule_scope` on `(scope_type, scope_id, kind)`.

### `authz_rule_subject`

| Column | Type | Meaning |
| --- | --- | --- |
| `rule_id` | str(160), PK | The rule. |
| `list` | str(8), PK | Which subject list of the rule. |
| `subject_type` | str(32), PK | Subject type. |
| `subject_id` | str(64), PK | Subject id. |
| `subject_role` | str(128), PK, default `''` | Set role, empty for a principal. |

### `authz_link`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | str(36), PK | Link id; its grant is an assignment to `link:<id>`. |
| `token_hash` | str(128), unique | `v1:` and an HMAC-SHA256 of the token. |
| `scope_type` | str(64) | Scope type. |
| `scope_id` | str(64) | Scope id. |
| `attributes` | text, `@Json`, null | Link attributes. |
| `expires_at` | datetime, null | Expiry. |
| `revoked_at` | datetime, null | Revocation instant. |
| `created_by` | str(100), null | Principal key of the actor. |
| `created_at` | datetime | Creation instant. |

### `authz_version`

| Column | Type | Meaning |
| --- | --- | --- |
| `domain` | str(64), PK | Authz domain name. |
| `version` | bigint, `@Int64('string')` | Bumped by every store write; read as the same text on every driver. |

### `authz_admin_idempotency`

| Column | Type | Meaning |
| --- | --- | --- |
| `domain` | str(64), PK | Authz domain. |
| `actor` | str(100), PK | Principal key of the actor. |
| `idem_key` | str(160), PK | The batch's `idempotencyKey`. |
| `results` | text | The batch results as JSON (dates revived). |
| `rows` | text | The rows the batch touched as JSON. |
| `expires_at` | datetime | End of the replay window. |
| `created_at` | datetime | Creation instant. |

Index `authz_admin_idempotency_expires` on `expires_at`.

### Migrations

| Migration | Connection | Does |
| --- | --- | --- |
| `AuthzRbac_2026_10_01_00_00_00` | `authz` | Creates the six RBAC tables above. |
| `AuthzAdminIdempotency_2026_10_02_00_01_00` | `authz` | Creates `authz_admin_idempotency`. |

The migrations create tables only. None reads, copies or alters a 2.x table: 3.0 starts from an empty database, and roles are granted as assignments (`AuthzAdmin.assign`, or `authz:assign` from the [CLI](13-cli-commands.md)). See [the migration guide, section 7](../authz/migration-guide.md#7-data-migration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Assignment store | `AssignmentStore`, `AdminAssignmentStore`; per child container; registered by `registerRbacStores` | `DbAssignmentStore` | `MemoryAssignmentStore`, `MemoryAdminAssignmentStore` | Register a class under its name and list it in `authz.rbac.stores.assignments`. |
| Membership store | `MembershipStore`, `AdminMembershipStore` | `DbMembershipStore` | `MemoryMembershipStore` | `authz.rbac.stores.membership`. |
| Rule store | `RuleStore`, `AdminRuleStore` | `ConfigRuleStore` | `DbRuleStore`, `MemoryRuleStore` | `authz.rbac.stores.rules`; at most one in-memory and one other store. |
| Link store | `LinkStore`, `AdminLinkStore` | `DbLinkStore` | `MemoryLinkStore` | `authz.rbac.stores.links`. |
| Admin backend | `AuthzAdminBackend`, singleton, `@Injectable(AuthzAdminBackend)` at import | `MemoryAuthzAdminBackend` (from `@spinajs/authz`) | `DbAuthzAdminBackend` | `authz.admin.backend` names the registered class. |

A DB store reaches its tables only through its record, so it follows `db.Aliases.authz` with no option of its own. `DbAuthzAdminBackend` takes no constructor options.

### A store with an extra rule: custom implementation

Extend a DB store to add a check before a write; keep the transaction and the version bump of the base class by calling `super`. Register the subclass under its own class name and name it in config.

```ts
import { Injectable, PerChildInstance, Inject, Container } from '@spinajs/di';
import { AuthzAdminFailure } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef } from '@spinajs/authz';
import type { Assignment } from '@spinajs/authz-rbac';
import { DbAssignmentStore } from '@spinajs/authz-rbac';

@PerChildInstance()
@Injectable()
@Inject(Container)
export class ExpiringAssignmentStore extends DbAssignmentStore {
  readonly name = 'ExpiringAssignmentStore';

  async assign(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    if (a.scope.type === '$global' && !a.expiresAt) {
      throw new AuthzAdminFailure('invalid_command', 'a $global assignment needs an expiry', 'expiresAt');
    }
    return super.assign(a, actor, tx);
  }
}

// config: authz.rbac.stores.assignments: ['ExpiringAssignmentStore']
```

## Important behaviour

- **One connection per table set.** A write whose `AuthzTx` runs on another connection than the record is refused, so data never lands where reads do not look.
- **Lazy ORM.** The records exist only after the `Orm` boots. Import `@spinajs/authz-rbac` before the `Orm` resolves, so it binds the records.
- **Post-boot migrations.** A migration that creates the authz tables after the ORM booted (a test, or `Migration.OnStartup: false` with a later in-process run) needs `db.StrictTableCheck: false` and then `orm.reloadTableInfo({ strict: true })` before the stores read.
- **Two clocks.** Store reads judge expiry by `AuthzClock`; `.accessible()` lists judge it by the database's now ([List filter term](01-list-filter-term.md)).
- **Version bumps.** One admin batch bumps `authz_version` once per write, in one transaction. Do not rely on the count.
- **Same grant twice.** Granting the same subject, role and scope again updates tags, expiry and grantor of the row and keeps its id, `created_at` and `source`.
- **No length checks.** A role over 128 characters, a subject id over 64 or tags over 512 give a raw database error on PostgreSQL; SQLite stores them. A subject key longer than the `subject_key` column is refused (`invalid_command`).
- **SQLite** runs one outermost transaction at a time, so batches of different domains wait there.

## Best practices

- Point `db.Aliases.authz` at the database that holds your `@AccessResource` tables: the list filter joins them with `authz_assignment` ([`@spinajs/authz-orm`](../authz-orm/03-authz-connection-and-records.md)).
- Call `AuthzAdmin` outside your own `db.transaction()`: the backend refuses to nest, so the domain lock is never held until your commit.
- Resolve the `Orm` (`await DI.resolve(Orm)`) before a write path runs in a script; a write before it fails with `AuthzConfigError`.

## Patterns and antipatterns

```ts
// Don't: no package reads these keys, so the tables stay on 'default'
authz: { rbac: { connection: 'authz-db' }, admin: { connection: 'authz-db' } }

// Do: map the alias
db: { Aliases: { authz: 'authz-db' } }
```

```ts
// Don't: AuthzAdmin inside your own transaction on the authz connection is refused (AuthzConfigError)
await driver.transaction(async () => {
  await project.insert();
  await authz().admin().assign(actor, ownerGrant);
});

// Do: commit your rows, then run the batch
await driver.transaction(async () => {
  await project.insert();
});
await authz().admin().assign(actor, ownerGrant);
```

## Examples

### Keep authz tables in a separate database

```ts
export default {
  db: {
    // 'authz-db' is a connection declared in db.Connections next to 'default'
    Aliases: { authz: 'authz-db' },
  },
  authz: { admin: { backend: 'DbAuthzAdminBackend' } },
};
// Run `spinajs migrate-up` without --connection, so default and authz-db migrate in one run.
```

### Create the tables in a test after the ORM booted

```ts
// test config: db.StrictTableCheck: false, Migration.OnStartup: false
const orm = await DI.resolve(Orm);
// ... run the authz-rbac migrations on the authz connection ...
await orm.reloadTableInfo({ strict: true });   // binds the records to the new tables before a store reads
```

## Migration

`authz.rbac.connection`, `authz.admin.connection` and `DbAuthzAdminBackendOptions` are gone; the keys are no longer read. `authz.rbac.migration.roleColumn`, `authz.rbac.migration.idColumn`, the `users.Role` migrations (`AuthzRbacUserRoles_2026_10_01_00_01_00`, `AuthzRbacDropUserRole_2026_10_01_00_02_00`) and the `USER_ROLES_*` exports are gone too: grant roles as assignments.

Before:

```ts
authz: {
  rbac: { connection: 'authz-db' },
  admin: { connection: 'authz-db', backend: 'DbAuthzAdminBackend' },
}
```

After:

```ts
db: { Aliases: { authz: 'authz-db' } },
authz: {
  admin: { backend: 'DbAuthzAdminBackend' },
}
```

Code that built the backend by hand drops its options: `new DbAuthzAdminBackend()`.

## Related

- [How a check resolves](05-check-resolution.md): how the model reads the stores and caches their rows.
- [Custom stores](11-custom-stores.md): the store ports and how to replace a store.
- [AuthzAdmin](../authz/10-authz-admin.md): the command bus that drives every write.
- [Tables](../authz/storage-and-check-flow.md#tables): all authz tables of every package in one place.
- [`@spinajs/authz-orm`](../authz-orm/README.md): the ancestor and scope attribute tables on the same `authz` alias.
- [`@spinajs/authz-abac`](../authz-abac/README.md): `authz_policy` on the same alias.
