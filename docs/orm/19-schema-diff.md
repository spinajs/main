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

A type the profile does not list is not compared (`MIG003`), and without a profile no type is compared. A third-party driver adds both members to its own profile; the shipped drivers (`@spinajs/orm-postgres`, `-pglite`, `-sqlite`, `-mysql`, `-mssql`) list the types their schema builder creates.

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
