# Schema diff: models to migrations

`@spinajs/orm` can compare the schema your models declare with a live database and describe the difference. `spinajs migrate-diff` (`@spinajs/orm-cli`) is the command; the functions below are what it runs.

## Models may be partial

A model declares the columns the app uses; the table may have more (a column another package's migration added, a legacy or shared table). The rules:

1. **One target per table.** Every model mapped to the same table on the same connection contributes its columns; the target is their union. Two models declaring one column with different specs is `MIG001` (error). An inferred spec (a column whose `@Column` states no `family`, or that has no `@Column`: the family comes from the TypeScript type) yields to an explicit one of the same family; its flags (`unique`, `default`, …) are explicit and must agree.
2. **Unmanaged columns.** A live column no model declares is listed (`MIG002`, info) and never dropped.
3. **Drops** are proposed only when the column was declared in the `--base` manifest and is gone now, when the model is `@Model('t', { columns: 'exhaustive' })`, or for `--prune t.column`. Every drop is `DESTRUCTIVE`. The same three triggers apply to a table no model maps: a table the `--base` manifest mapped and no current model maps is a `DESTRUCTIVE` `dropTable`; a live table no model maps is otherwise never touched.
4. An unmanaged column that is `NOT NULL` without a default makes model inserts fail: `MIG004` (warning) names the models.
5. **Altering a declared column changes only what the model states.** An inferred column keeps its live `NOT NULL`; a column without `@Column({ default })` keeps its live default; the generated `modify()` call carries them, because the dialect compilers rebuild the whole column definition otherwise.

## What is compared

| Aspect | Compared for | Notes |
|---|---|---|
| Existence | every declared column | missing → added |
| Family (`integer`, `text`, `datetime`, …) | every declared column | integer → bigint is safe; any other change is `DESTRUCTIVE` |
| Length | explicit `@Column({ length })` | only where the driver reports lengths (postgres, mssql); sqlite and mysql report none, so `MIG003` |
| Nullability | explicit `@Column` | never for sqlite booleans, which sqlite always creates `NOT NULL` |
| Indexes, unique columns | `@Index`, `@Column({ unique })` | needs the driver's `tableIndexes()`, otherwise `MIG003` |
| Foreign keys | `@BelongsTo` with a foreign key | created with a new table only; one missing on an existing table is `MIG005` |
| Defaults, primary keys | not compared | emitted when a table or column is created |

Adding a `NOT NULL` column without a default to a table that has rows, narrowing a type or a length, and setting `NOT NULL` on a table with rows are `DESTRUCTIVE`.

## Native types come from the driver

A live column reports a native type (`int4`, `nvarchar`, `TEXT`). Which families it can hold is not known to `@spinajs/orm`: each driver states it in the profile it declares with `@SqlDialect` (the same profile `spinajs doctor` reads for raw SQL):

| Member | Meaning |
|---|---|
| `nativeTypes` | Native type, lower case and without its size, to the families it can hold, such as `{ varchar: ['text', 'enum'], int4: ['integer'] }` |
| `untrustedNullability` | Families whose live `NOT NULL` says nothing about the model; sqlite lists `boolean` |
| `caseInsensitiveIdentifiers` | The database compares unquoted identifiers ignoring case, so table and column names match ignoring case (`Id` and `id` are one column) and the generated code keeps the model's spelling; sqlite, mysql and mssql set it. Postgres and PGlite do not: the drivers quote names there, so `name` and `Name` are two columns |
| `unboundedText` | A text column's declared length is not enforced, so re-stating one on a modify is not `DESTRUCTIVE`; sqlite sets it. A `binary` length still is |
| `alterColumnRebuildsTable` | A column is altered by rebuilding its table, which fails while foreign keys are enforced and another table references it (`MIG006`); sqlite sets it |

A type the profile does not list is not compared (`MIG003`), and without a profile no type is compared. A third-party driver adds the members that hold for its database to its own profile; the shipped drivers (`@spinajs/orm-postgres`, `-pglite`, `-sqlite`, `-mysql`, `-mssql`) list the types their schema builder creates.

## API

```ts
import type { Diagnostic } from '@spinajs/manifest';
import { buildTargetSchema, diffSchema, sqlDialectOf } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

const diagnostics: Diagnostic[] = [];
const target = buildTargetSchema(manifest, ['default'], diagnostics);                     // MIG001
const changes = diffSchema(target, columns, extras, { dialect: sqlDialectOf(SqliteOrmDriver), diagnostics });   // MIG002–MIG005
```

`columns` maps each table to its `tableInfo()` descriptors; `extras` maps it to its `tableIndexes()`, `tableForeignKeys()` and whether it has rows.

| Code | Severity | Meaning |
|---|---|---|
| `MIG001` | error | Two models declare one column with different specs |
| `MIG002` | info | A live column no model declares; left as it is |
| `MIG003` | info | An aspect was not compared (no lengths, no index or foreign-key introspection, unknown type or dialect) |
| `MIG004` | warning | An unmanaged column is `NOT NULL` without a default |
| `MIG005` | info | A declared foreign key is missing on an existing table |
| `MIG006` | warning | A column change rebuilds a table that a live or a created table references, which fails while foreign keys are enforced. Only tables a model or `--base` maps are checked; a referencing table no model maps is not, and the driver's own `NotSupported` stops that step when it runs |

## Generating the migration

`generateMigration(changes, { name, connection, allowDestructive, now })` writes a `@Migration` class named `<name>_yyyy_MM_dd_HH_mm_ss` over the schema builder, so the existing runner, checksum and lock run it:

```ts
@Migration('default')
export class SchemaDiff_2026_11_03_10_20_30 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('users', (table) => {
      table.dateTime('EmailVerifiedAt');
    });
    // DESTRUCTIVE: users.Legacy was removed from the models since --base (pass --allow-destructive to run it)
    // await connection.schema().alterTable('users', (table) => {
    //   table.dropColumn('Legacy');
    // });
  }
  …
}
```

Tables are created before the tables that reference them, then columns are added, altered, indexed, and dropped. `down()` reverses created tables, added columns and added indexes. A `DESTRUCTIVE` step stays a comment unless `allowDestructive` is set. `introspectSchema(driver, tables)` reads `tableInfo()`, the driver's `tableIndexes()`/`tableForeignKeys()` where it has them, and whether each table has rows.

A `modify()` re-states the whole column, so it keeps what the spec does not state from the live column:
- the nullability of an inferred column;
- the default, verbatim when the driver reports an expression (`DEFAULT CURRENT_TIMESTAMP` stays `CURRENT_TIMESTAMP`);
- `unsigned` and `unique`;
- the length, when the driver reports one.

An aspect the driver does not report cannot be kept, so re-stating it makes the change `DESTRUCTIVE`:
- the precision of a `decimal` (`precision not compared; re-stated as (10,2)`, or `as the driver's default` without one);
- an explicit text length on mysql, or a binary length on sqlite or mysql (`length not compared; re-stated as 50`); sqlite stores text as `TEXT`, so its profile's `unboundedText` skips the text case;
- a live default that a value converter turned into an object, such as a `TimeSpan` (`live default not re-statable`).

On a driver that reports no length (mysql), a modify of a text column whose spec states no length rewrites `VARCHAR(n)` as `TEXT`, and an index on that column can then fail. Give such a column an explicit `length`.

Other limits of a modify:
- A `uuid` column is re-stated as `binary(16)`: the schema builder has no other uuid type outside `createTable`, so on postgres a modify re-types a native `uuid` column to `bytea`. Review such a step before running it.
- sqlite modifies a column by rebuilding the table, and refuses to do so while `PRAGMA foreign_keys` is on and another table references it; `diffSchema` warns `MIG006` for it. Alter such a table in a hand-written migration.

## Running or printing the steps

`runStep(driver, step)` runs one planned step (`planMigration(changes)[i].step`) on a driver, as the generated `up()` would. `renderSql(changes, driver, { allowDestructive })` returns the DDL those steps compile to on the driver's dialect without writing to the database: the steps run on a copy of the driver that records each statement, answers every query with no rows, and runs a transaction body without opening a transaction. A `DESTRUCTIVE` step is left out unless `allowDestructive` is set, as one `-- DESTRUCTIVE <kind> <table>: <reason> (left out; pass --allow-destructive)` line. A step that needs the live table to compile (a sqlite column change, which rebuilds the table and reads its definition, while the recorder answers no rows) yields one `-- <kind> <table> is not compiled offline: <driver error>` line instead. Statements carry no trailing `;`. The driver must send its DDL through `executeOnDb` and open transactions through `transaction()`; `renderSql` refuses a driver without `executeOnDb` with `NotSupported`. `spinajs migrate-diff --sql` prints this list; the command is described in [Generating migrations](../orm-cli/09-generating-migrations.md).
