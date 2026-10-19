# Schema and migration

The package stores model translations in `intl_resources` and phrase translations in `intl_translations`. Both tables live on the `default` connection and are created by the shipped migration `IntlOrm_2022_06_28_01_13_00`.

## How it works

1. Importing `@spinajs/intl-orm` evaluates `@Migration('default')` on `IntlOrm_2022_06_28_01_13_00`, which registers it in DI. `DiRegistryMigrationSource` of `@spinajs/orm` finds it with no directory scan.
2. The models `IntlResource` (`@Model('intl_resources')`) and `IntlTranslation` (`@Model('intl_translations')`) are bound to `@Connection('default')`, the connection named by `db.DefaultConnection`.
3. At `Orm.resolve()`, the migration runs with the other pending migrations when the connection has `Migration.OnStartup` set, or on `orm.Migration.up()`.
4. `up()` creates both tables and their unique indexes. `down()` drops both tables.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.DefaultConnection` | `string` | none | a configured connection name | The connection behind `'default'`: where both tables are created and queried. |
| `db.Connections[].Migration.OnStartup` | `boolean` | `false` | `true`, `false` | Applies the migration when `Orm` boots. See [Migrations](../orm/10-migrations.md#configuration). |

```ts
db: {
  DefaultConnection: 'main',
  Connections: [
    { Name: 'main', Driver: 'orm-driver-sqlite', Filename: './data/app.sqlite', Migration: { OnStartup: true } },
  ],
}
```

## Schema

### `intl_resources`

One row per entity, column and language. Read and written by [Translatable models](01-translatable-models.md) and [Query translation](02-query-translation.md).

| Column | Type | Meaning |
| --- | --- | --- |
| `ResourceId` | `int`, not null | Primary key value of the translated entity. |
| `Resource` | `string(32)`, not null | Model class name, eg. `Product`. |
| `Column` | `string(16)`, not null | Property name of the translated column, eg. `Name`. |
| `Lang` | `string(6)`, not null | Language, eg. `en_GB`. |
| `Value` | `text` | Translated value. |

Unique index `intl_resources_idx` on (`ResourceId`, `Resource`, `Column`, `Lang`). There is no primary key column; `IntlResource` declares no `@Primary()`.

### `intl_translations`

One row per phrase and language. Read by the [Database translation source](05-database-translation-source.md).

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto-increment | Row id. |
| `Key` | `string(32)`, not null | Phrase key passed to `__()`. |
| `Value` | `text` | Translated phrase. |
| `Lang` | `string(6)`, not null | Language, eg. `de_DE`. |

Unique index `intl_translations_idx` on (`Key`, `Lang`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `IntlOrm_2022_06_28_01_13_00` | `@Migration('default')`, registered at import in the DI migration registry; built by the migration runner | `IntlOrm_2022_06_28_01_13_00` | none | Ship a later migration of your own that alters the tables, eg. widens a column. The class name is the migration's identity; do not rename or re-register it. |
| `IntlResource` | Model class, not in DI | `IntlResource` | none | Not replaceable: `Translatable` and `IntlModelRelation` import the class directly. Query it like any model. |
| `IntlTranslation` | Model class, not in DI | `IntlTranslation` | none | Not replaceable: `DbTranslationSource` imports it directly. Replace the source instead, see [Database translation source](05-database-translation-source.md). |

### Migration: widen the language and column names

`intl_resources.Lang` and `intl_translations.Lang` hold 6 characters (`en_GB` fits, `zh_Hant` does not), and `intl_resources.Column` holds 16. Add your own migration with a later timestamp to widen them. SQLite does not enforce the lengths, so the migration changes nothing there, but each `alterTable()` still rebuilds its table; see [SQLite: modifying columns](../orm-sqlite/04-schema-and-ddl.md#modifying-columns).

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('default')
export class WidenIntlColumns_2026_10_17_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('intl_resources', (table) => {
      table.string('Lang', 16).notNull().modify();
      table.string('Column', 64).notNull().modify();
    });

    await connection.schema().alterTable('intl_translations', (table) => {
      table.string('Lang', 16).notNull().modify();
      table.string('Key', 255).notNull().modify();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('intl_resources', (table) => {
      table.string('Lang', 6).notNull().modify();
      table.string('Column', 16).notNull().modify();
    });

    await connection.schema().alterTable('intl_translations', (table) => {
      table.string('Lang', 6).notNull().modify();
      table.string('Key', 32).notNull().modify();
    });
  }
}
```

## Important behaviour

- `down()` drops `intl_translations` and `intl_resources`, with every translation in them.
- Both tables are on `default`. A model on another connection still has its translations on `default`, so a transaction on the model's connection does not cover its translation rows.
- SQLite does not enforce `string(n)` lengths; MySQL and MSSQL reject or truncate longer values. A test suite on SQLite will not catch a too-long `Column` or `Key`.
- `intl_resources` has no foreign keys. Deleting an entity leaves its rows.

## Best practices

- Seed translations in a migration's `data()` with `InsertBehaviour.InsertOrUpdate`, so a rerun does not hit the unique index.
- Check `Column` and `Resource` lengths against your model and property names before deploying on MySQL or MSSQL.

## Examples

### Seed English product names

```ts sample
import { InsertBehaviour, Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { IntlResource } from '@spinajs/intl-orm';

@Migration('default')
export class SeedProductNamesEn_2026_10_17_10_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}

  public async down(_connection: OrmDriver): Promise<void> {}

  public async data(): Promise<void> {
    const names: Array<[number, string]> = [
      [1, 'Desk lamp'],
      [2, 'Office chair'],
    ];

    for (const [id, name] of names) {
      await new IntlResource({ ResourceId: id, Resource: 'Product', Column: 'Name', Lang: 'en_GB', Value: name }).insert(InsertBehaviour.InsertOrUpdate);
    }
  }
}
```

## Related

- [Migrations](../orm/10-migrations.md): discovery, ordering, `data()` and `OnStartup`.
- [Schema builder](../orm/09-schema-builder.md): `createTable()`, `alterTable()` and indexes.
- [Connections](../orm/01-connections.md): `db.DefaultConnection` and the `default` alias.
