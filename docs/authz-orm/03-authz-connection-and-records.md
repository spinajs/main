# The `authz` connection and records

authz-orm keeps the ancestor table and the scope attribute tables on the ORM connection alias `authz`, the alias every authz table uses. It reads and writes them only through ORM models (records), so one config key, `db.Aliases.authz`, picks their database, and the ORM handles each dialect.

## How it works

1. authz-orm's package config (`config/db.ts`) sets `db.Aliases.authz: 'default'`. Package config merges before the app's, so an app's `db.Aliases.authz` wins.
2. `Orm.resolve()` stores the named connection under the extra name `authz` ([`@spinajs/orm` connections](../orm/01-connections.md)). The records `AncestorRecord`, `ScopeAttributeRecord` and `ScopeAttributeVersionRecord` carry `@Connection('authz')` (`AUTHZ_CONNECTION` from `@spinajs/authz`), and the migrations `AuthzResourceAncestor_2026_10_14_00_00_00` and `AuthzScopeAttribute_2026_10_02_00_00_00` run there.
3. At the root domain's boot, `DefaultAuthzService` runs `checkRemovedConnectionKeys(config)`: `authz.rbac.connection` or `authz.admin.connection` fails boot with `AuthzConfigError`.
4. At every domain boot, `AuthzOrmContributor` runs `checkResourceConnections(orm)`. It fails with `AuthzConfigError` when no connection answers to `authz`, or when an `@AccessResource` model uses another connection. The list filter joins the resource table with `authz_assignment` and `authz_resource_ancestor`, so they must share one database.
5. On a write of an `@AccessResource` model, `AncestorMiddleware` checks that the statement's connection is the one `AncestorRecord` lives on, before it touches a row. It then reads and writes `authz_resource_ancestor` through `AncestorRecord` in the statement's transaction.
6. `authz:ancestors-verify` and `authz:ancestors-rebuild` take the connection of the type's first registered model, which must be the record's; a type without a model uses the record's connection.
7. `DbScopeAttributeStore` resolves the `Orm` before a read when nothing has (a CLI process boots only its command). A write runs only inside the `AuthzAdmin` transaction on the `authz` connection.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Aliases.authz` | `string` | `'default'` (authz-orm, authz-rbac and authz-abac package config) | a connection `Name` from `db.Connections` | The database of every authz table: `authz_resource_ancestor`, `authz_scope_attribute`, `authz_scope_attribute_version`, and the RBAC and ABAC tables. It must also hold the `@AccessResource` tables. |
| `authz.rbac.connection` | | | removed | Fails the root domain's boot: `authz.rbac.connection: removed; the authz tables use the ORM connection alias "authz", so set db.Aliases.authz to the connection name instead (default: "default")`. |
| `authz.admin.connection` | | | removed | Fails boot the same way. |

```ts
export default {
  db: {
    Connections: [{ Name: 'main', Driver: 'orm-driver-postgres', Database: 'app' }],
    Aliases: { authz: 'main' },
  },
};
```

## Schema

### `authz_resource_ancestor`

Migration `AuthzResourceAncestor_2026_10_14_00_00_00`, record `AncestorRecord`. One row per proper ancestor of a resource: no self row, no `$global` row. Index `authz_resource_ancestor_up` on `(ancestor_type, ancestor_id)`.

| Column | Type | Meaning |
| --- | --- | --- |
| `resource_type` | varchar(64), PK | The resource's type. |
| `resource_id` | varchar(64), PK | The resource's id as text (`''` allowed). |
| `ancestor_type` | varchar(64), PK | The ancestor's type. |
| `ancestor_id` | varchar(64), PK | The ancestor's id as text. |
| `depth` | int | 1 for the direct parent. |

### `authz_scope_attribute`

Migration `AuthzScopeAttribute_2026_10_02_00_00_00`, record `ScopeAttributeRecord`. One row per scalar leaf of a scope node's attributes.

| Column | Type | Meaning |
| --- | --- | --- |
| `scope_type` | varchar(64), PK | The scope's type. |
| `scope_id` | varchar(64), PK | The scope's id; `''` for `$global`. |
| `path` | varchar(160), PK | The dotted leaf path. |
| `value_json` | varchar(1024) | The leaf as JSON (`@Json` on the record). |
| `value_text` | varchar(255), null | Every scalar as text. |
| `value_num` | decimal(20,6), null | A number below 10^14 in magnitude. |
| `updated_by` | varchar(100), null | The actor's principal key. |
| `updated_at` | datetime | The write's instant. |

### `authz_scope_attribute_version`

Same migration, record `ScopeAttributeVersionRecord`. One row (`id` 1), seeded by the migration.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | int, PK | Always 1. |
| `version` | varchar(36) | A fresh UUID on every write. |
| `updated_at` | datetime | The last write's instant. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DbScopeAttributeStore` | Not registered. Register one instance under `ScopeAttributeStore` and `WritableScopeAttributeStore`. | | `MemoryScopeAttributeStore` (`@spinajs/authz`) | `new DbScopeAttributeStore()` takes no arguments; register your own `WritableScopeAttributeStore` instead. |
| `AncestorRecord`, `ScopeAttributeRecord`, `ScopeAttributeVersionRecord` | ORM models on `@Connection('authz')`, registered when the package is imported | | | Not meant to be replaced. Write through the ancestor middleware and `AuthzAdmin`, never through the records. |
| `readAncestors(refs)` | exported function | | | Reads the rows of each ref as resource, keyed by `resourceKey`, nearest first. One statement per resource type. |
| `checkResourceConnections(orm)` | exported function, run by `AuthzOrmContributor` | | | Call it in a test to assert the connection rule. |

### Register the database scope attribute store

```ts sample
import { ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { DI } from '@spinajs/di';

const scopeAttributes = new DbScopeAttributeStore();
DI.register(() => scopeAttributes).as(ScopeAttributeStore);
DI.register(() => scopeAttributes).as(WritableScopeAttributeStore);
```

Writes need `authz.admin.backend: 'DbAuthzAdminBackend'`, whose batch transaction runs on the `authz` connection.

## Important behaviour

- **One connection for resources and authz tables.** A resource write, `authz:ancestors-verify` or `authz:ancestors-rebuild` on another connection fails before it touches a row: `… runs on connection "X", but authz_resource_ancestor is on connection "Y" (db.Aliases.authz)`.
- **The Orm must be resolved.** A record used before the `Orm` resolved fails with `AuthzConfigError` (`the Orm is not resolved yet; resolve it (await DI.resolve(Orm)) before the authz tables are used`). A missing alias fails with `no ORM connection answers to "authz"; set db.Aliases.authz`. `DbScopeAttributeStore` resolves the `Orm` itself before a read.
- **No hand-made chunks.** `readAncestors`, the ancestor writes, `readParents`, `findRows` and the scope attribute writes run one statement per type or class. The ORM splits long inserts and binds long `whereIn` lists ([`@spinajs/orm-sql` statements](../orm-sql/03-statements.md)).
- **An id no row can hold stays out of the query.** Before it loads resource rows by id, authz-orm asks the ORM's `lookupValue()` whether the key column's type can hold the text id (a non-numeric id on an integer column, integer text beyond the column's range, a non-UUID on a UUID column). Such an id is a miss, never a bound value. The key column is found in any case (`findColumn()`).
- **A bad scope attribute row names its path.** Reads take `path` and `value_json` raw and parse each row. Text that is not JSON throws `AuthzConfigError` (`authz_scope_attribute row "<path>": value_json holds …, not JSON`) with the `SyntaxError` as cause; JSON that is not a scalar throws `… not a scalar`.
- **Writes queue on the version row.** `write()` and `forget()` update `authz_scope_attribute_version` first. Its row lock queues concurrent writers, so each reads the node only after the one before it committed. A missing version row throws `AuthzConfigError` naming the migration.
- **Writes need the admin transaction.** Outside an `AuthzAdmin` transaction, `write()` and `forget()` throw `AuthzConfigError` (`stores write only inside an AuthzAdmin transaction`); a transaction on another connection throws the connection message above.
- **A migration run after boot.** Tables created after the `Orm` booted need `db.StrictTableCheck: false` at boot and `orm.reloadTableInfo({ strict: true })` before the records read them ([the authz guide](../authz-rbac/README.md)).

## Best practices

- Map `db.Aliases.authz` once, in the app's config, to the connection that holds the `@AccessResource` tables.
- Migrate `default` and the `authz` connection in the same run when the alias points elsewhere ([the migration guide](../authz/migration-guide.md#7-data-migration)).
- After a raw import of rows with `@Parent` columns, run `authz:ancestors-rebuild`; `authz:ancestors-verify` exits with code 1 on drift.

## Patterns and antipatterns

```ts
// Don't: removed keys fail boot
export default { authz: { admin: { connection: 'main' }, rbac: { connection: 'main' } } };

// Do
export default { db: { Aliases: { authz: 'main' } } };
```

## Migration

`DbScopeAttributeStoreOptions` (`connection`, `container`), `storesConnection`, `parseAttributeLeaf`, `chunks`, `ROW_CHUNK`, `ID_CHUNK` and `ANCESTOR_COLUMNS` are removed. `readAncestors` takes no driver, and `checkResourceConnections` takes no config.

```ts
// Before
const store = new DbScopeAttributeStore({ connection: 'main' });
const rows = await readAncestors(driver, refs);
checkResourceConnections(orm, configuration);
// config: authz: { admin: { connection: 'main' } }

// After
const store = new DbScopeAttributeStore();
const rows = await readAncestors(refs);
checkResourceConnections(orm);
// config: db: { Aliases: { authz: 'main' } }
```

## Related

- [Access lists](01-access-lists.md): `.within()` and the RBAC term read `authz_resource_ancestor`.
- [`@spinajs/authz`](../authz-rbac/README.md): the other tables on `authz` and the removed keys.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the RBAC stores and migrations on the same alias.
- [`@spinajs/orm` connections](../orm/01-connections.md): `db.Aliases` and `db.StrictTableCheck`.
- [The ancestor table](06-ancestor-table.md): how the middleware and the CLI keep `authz_resource_ancestor` right.
- [Database audit](08-database-audit.md): `authz_audit`, on its own connection name `authz-audit`.
