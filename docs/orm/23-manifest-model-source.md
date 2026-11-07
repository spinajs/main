# Model columns from the manifest

By default the ORM reads each model's table with `tableInfo()` at boot and merges what it finds into the model's columns: types, nullability, defaults, and columns only the database has. An app that boots from a required manifest can take the columns from `app.manifest.json` instead:

```ts
export default {
  system: { manifest: { mode: 'require' } },
  db: { Models: { Source: 'manifest' } },
};
```

| `db.Models.Source` | Columns come from | `tableInfo()` is used for |
|---|---|---|
| `'database'` (default) | the decorators merged with `tableInfo()` | the merge |
| `'manifest'`, in `require` mode | the decorators merged with the manifest's model columns | drift checks only |

With `'manifest'` in any other manifest mode the ORM warns once and keeps reading the database. A model the manifest does not list (a stale manifest) is warned about and keeps the database merge; rebuild the manifest with `spinajs build`. So is a model whose class and table name more than one manifest model has (an app subclass of a package model with the same name): the registered class does not say which entry it is.

`db.Models.Source` is a typed configuration path: apps that keep generated declarations rerun `spinajs generate:config-types` after upgrading, and `config.get('db.Models.Source')` is typed `'database' | 'manifest'`.

## What changes for model JSON schemas

Column types in `Schema`/`ResponseSchema` (what `orm-http` validates request bodies with and `http-swagger` publishes) do not change: a manifest column is named by its `ColumnType` (`int`, `string`, `dateTime`, …), so `Id: number` is still `{ type: 'integer' }`. **`required` does change:** it follows the TypeScript optionality of the field (`Name!: string` is required, `Nickname?: string` is not) instead of the table's `NOT NULL` flags. That is the point of the models being the source of truth, and it is the cost of the opt-in: a column declared `!:` that the table allows to be `NULL` becomes required in request validation. Review the `?:` marks of the models you opt in.

**Writes change too.** `Nullable` comes from the TypeScript optionality and `DefaultValue` only from `@Column({ default })`, so the write-time `NOT NULL` check and the defaults a new instance gets follow the model, not the table. With a table column `Rank INT NOT NULL DEFAULT 0` and a model field `Rank: number` without `@Column({ default: 0 })`, `Account.create({ Name })` throws `Field Rank cannot be null` under `'manifest'`, where `'database'` took the default from the table. The boot warns about every such column (drift kind `nullability`, below).

A column default the model declares as raw SQL (`@Column({ default: { raw: 'CURRENT_TIMESTAMP' } })`) is left to the database on insert, as a default `tableInfo()` reads as an expression is.

## Drift

Only the columns a model declares are checked:

- A declared column missing from its table fails the boot under `db.StrictTableCheck` (`Column drift (db.StrictTableCheck): column Nickname of model Account is missing from table accounts on connection default. …`) and is a warning otherwise. The check runs after the startup migrations, like the missing-table check, and is skipped when the `OrmMigrator` was resolved with `MigrateOnStartup: false` (`resolveMigrationTool()`). `reloadTableInfo({ strict: true })` fails on it too.
- A declared column whose live type belongs to another family (a `boolean` stored as `int4`) is a warning.
- A column the model requires (no `?`, no `@Column({ default })`) that the table allows to be `NULL` or fills with a default is a warning (`nullability`): writes without a value fail where the table would have accepted them.

Column names are compared ignoring case on drivers whose dialect profile sets `caseInsensitiveIdentifiers` (sqlite, mysql, mssql). Families are compared only for native types the driver's profile lists in `nativeTypes`.

`Orm.ColumnDrift` lists what the last reads found. `reloadTableInfo({ models })` (what `migrate()` calls for the tables it touched) warns only the drift of the models it read.

A column the table has and no model declares is normal (a partial model). `select *` still puts its value on the instance, without a converter, and `save()` never writes it.

## Converters

A column's converter is looked up by its `@Column({ nativeType })`, else by the `ColumnType` name of its family, instead of by the type name the database reports. Default converters exist for `boolean`, `time`, `datetime` and `date` (the last two are registered when the manifest source is active); `json`, `uuid`, `binary`, `decimal`, `float`, `enum`, `text` and `integer` have none, as today. Converters that decorators set (`@DateTime`, `@CreatedAt`, `@Json`, `@Uuid`, …) apply as before.

In 5.0, `'manifest'` becomes the default in `require` mode and the database merge is removed.
