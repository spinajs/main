# Customizing dialect compilers

Every PostgreSQL compiler this package ships is exported, so you can subclass the one registered today and change a single method, or register a class for a token the driver leaves unsupported. Do it in a driver subclass's `resolve()`, after `super.resolve()`.

## How it works

1. **Pick the token.** Find the token that writes the SQL you want to change in [What the driver registers](06-extending-the-driver.md#what-the-driver-registers), e.g. `ColumnQueryCompiler`.
2. **Subclass the registered class.** Extend the PostgreSQL class (`PostgresColumnQueryCompiler`), or the shared `Sql*` class for a token the driver claims from `@spinajs/orm-sql`. Keep `@NewInstance()`, and `@Inject(Container)` when the parent has it.
3. **Override a hook.** Each class splits its SQL into protected or public methods (table below). Override the smallest one; call `super` for the rest.
4. **Register.** In a `PostgresOrmDriver` subclass: `super.resolve()`, then `this.Container.register(MyCompiler).as(<token>)`.
5. **Resolve.** The builder that needs the token resolves it from the connection's container with fixed arguments (the builder, sometimes the container first). Your class receives the same arguments.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Column DDL | `ColumnQueryCompiler`, `@NewInstance()`, resolved with `[columnBuilder]` | `PostgresColumnQueryCompiler` | `SqlColumnQueryCompiler` | Override `typeExpression()`, `_defaultCompiler()` or `compile()`. Must stay a `PostgresColumnQueryCompiler` subclass: `modify()` calls `typeExpression()` and `defaultExpression()` on it. |
| Alter column | `AlterColumnQueryCompiler`, `@NewInstance()`, `@Inject(Container)`, resolved with `[columnBuilder]` | `PostgresAlterColumnQueryCompiler` | `SqlAlterColumnQueryCompiler` | Override `_add(definition)`, `_modify(definition)`, `_rename()`, `_columnDefinition()`; set `IsStandaloneStatement` to emit a statement without the `ALTER TABLE` prefix. |
| Insert | `InsertQueryCompiler`, `@NewInstance()`, `@Inject(Container)`, resolved with `[builder]` | `PostgresInsertQueryCompiler` | `SqlInsertQueryCompiler` | Override `into()`, `ignore()`, `returning()`, `autoIncrementPlaceholder()`, `values()`, `columns()`, `upsort()` or `compile()`. |
| Upsert | `OnDuplicateQueryCompiler`, `@NewInstance()`, resolved with `[duplicateBuilder]` | `PostgresOnDuplicateQueryCompiler` | `SqlOnDuplicateQueryCompiler` | Override `compile()`; `this._builder` gives `getColumn()`, `getColumnsToUpdate()`, `getReturning()`, `getParent()`. |
| Limit | `LimitQueryCompiler`, `@NewInstance()`, resolved with `[builder]` | `PostgresLimitQueryCompiler` | `SqlLimitQueryCompiler` | Override `compile()`; `this._builder.getLimits()` gives `{ limit, offset }`. |
| Table reference | `TableAliasCompiler`, `@NewInstance()`, resolved with no arguments; `compile(builder, tbl?)` is called per table | `PostgresTableAliasCompiler` | `SqlTableAliasCompiler` | Implement `compile(builder, tbl?)`. |
| Table exists | `TableExistsCompiler`, `@NewInstance()`, resolved with `[builder]` | `PostgresTableExistsCompiler` | | Override `compile()`; `this.builder.Table` and `this.builder.Database` (the schema). |
| Create database | `CreateDatabaseCompiler`, `@NewInstance()`, `@Inject(Container)`, resolved with `[builder]` | `PostgresCreateDatabaseQueryCompiler` | `SqlCreateDatabaseQueryCompiler` | Override `compile()`; `this.builder.Name`, `Charset`, `Collation`, `Exists`. |
| Default values | `DefaultValueBuilder`, `@NewInstance()`, resolved with `[columnBuilder]` when `.default()` is called | `PostgresDefaultValueBuilder` | `SqlDefaultValueBuilder` | Override `date()`, `dateTime()`, `value()`, `raw()`; set `this.Query` or `this.Value` and return `this.Owner`. |
| Views | `CreateViewCompiler`, `@NewInstance()`, `@Inject(Container)`, resolved with `[builder]` | `PostgresCreateViewCompiler` | `SqlCreateViewQueryCompiler` | Override `_replace()`, `_temporary()`, `_prefixOptions()`, `_withOptions()`, `_checkOption()`, `_ifNotExists()`, `_body()`. See [View compiler hooks](../orm-sql/06-view-compiler-hooks.md). |
| Truncate | `TruncateTableQueryCompiler`, `@NewInstance()`, resolved with `[container, builder]` | `SqlTruncateTableQueryCompiler` | | Subclass and override `compile()`. |
| Lock table | `LockTableQueryCompiler`, `@NewInstance()`, `@Inject(Container)`, resolved with `[builder]` | `PostgresLockTableQueryCompiler` (`LOCK TABLE ... IN SHARE MODE`) | | Subclass and override `compile()`, which returns an array of outputs, e.g. for `IN EXCLUSIVE MODE`. |
| `IN` list | `InStatement`, `@NewInstance()`, resolved per `whereIn()` / `whereNotIn()` | `PostgresInStatement` | `SqlInStatement` | Override `listExpression(column)` (`= ANY(?)` / `<> ALL(?)`), `listBinding(values)` (the array) or set `listThreshold` (`1000`). |
| Database clock | `NowExpression`, resolved by `driver.now()` | `PostgresNowExpression` (`CURRENT_TIMESTAMP`) | | Subclass and override `sql()`. `PostgresDefaultValueBuilder.dateTime()` constructs `PostgresNowExpression` directly, so column defaults keep `CURRENT_TIMESTAMP`. |
| Drop database, alter table, recursive CTE | `DropDatabaseCompiler`, `AlterTableQueryCompiler`, `RecursiveQueryCompiler` | `SqlDropDatabaseQueryCompiler`, `SqlAlterTableQueryCompiler`, `SqlWithRecursiveCompiler` | | Subclass the shared class and override `compile()`. |
| Events | `EventQueryCompiler`, `DropEventQueryCompiler`, `@NewInstance()`, `@Inject(Container)`, resolved with `[builder]` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` (throw `MethodNotImplemented`) | | Extend the abstract token and implement `compile()`; also return `events: true` from `supportedFeatures()`. |
| Table clone, table history | `TableCloneQueryCompiler`, `TableHistoryQueryCompiler` | not registered | | Implement the abstract token and register it. |

### `PostgresInsertQueryCompiler`

`compile()` concatenates `into()`, `columns()`, `values()`, `ignore()`, `upsort()` and `returning()`:

| Hook | Returns | Default on PostgreSQL |
| --- | --- | --- |
| `into()` | `INSERT INTO <table>` | table from `TableAliasCompiler`, no `IGNORE` |
| `columns()` | `("a","b")` | inherited |
| `values()` | `{ data: 'VALUES (?,?)', bindings }` | inherited; calls `autoIncrementPlaceholder()` for a missing identity key |
| `autoIncrementPlaceholder()` | SQL for an unsupplied identity key | `DEFAULT` |
| `ignore()` | conflict-skip clause | ` ON CONFLICT DO NOTHING` when `orIgnore()` and no upsert |
| `upsort()` | `{ expression, bindings }` of the upsert | `OnDuplicateQueryCompiler` output |
| `returning()` | ` RETURNING ...` | only without an upsert |

### `PostgresColumnQueryCompiler`

| Hook | Visibility | Returns |
| --- | --- | --- |
| `typeExpression()` | public | the bare type, e.g. `VARCHAR(255)`; throws for an unknown type |
| `defaultExpression()` | public | `DEFAULT ...` or `''`; calls `_defaultCompiler()` |
| `_defaultCompiler()` | protected | boolean numeric defaults as `TRUE`/`FALSE`, else the shared spelling |
| `compile()` | public | the full column definition |

## Important behaviour

- The container returns the last registration of a token. A class registered after `super.resolve()` replaces the PostgreSQL one; registered before, it is replaced.
- Compilers are `@NewInstance()`: one instance per compilation, so instance state does not leak between queries.
- Replacements apply only to connections whose driver registers them. The stock `orm-driver-postgres` connections are untouched unless you register your subclass under that string.
- `PostgresAlterColumnQueryCompiler` writes a `warn` log through the `ORM` logger when `after()` is used, because PostgreSQL appends new columns at the end.
- A compiler that renders an empty expression for an altered column is skipped by `SqlAlterTableQueryCompiler`, so a hook may return `''` to emit nothing.

## Best practices

- Subclass the class registered today and override one hook; copying `compile()` loses later fixes to the other hooks.
- Throw `NotSupported` or `MethodNotImplemented` for a clause you cannot express, as `PostgresCreateDatabaseQueryCompiler` and `PostgresCreateViewCompiler` do, instead of emitting SQL PostgreSQL rejects.
- Quote identifiers with `this.Quoter.quote()` and inline literals with the connection's `LiteralQuoter`; never concatenate names.
- Cover each replacement with a compile test against a recording driver; see [Test a dialect change without a server](06-extending-the-driver.md#test-a-dialect-change-without-a-server).

## Patterns and antipatterns

```ts
// Don't: a ColumnQueryCompiler that is not a PostgresColumnQueryCompiler breaks modify()
@NewInstance()
export class MyColumnCompiler extends SqlColumnQueryCompiler { /* ... */ }

// Do
@NewInstance()
export class MyColumnCompiler extends PostgresColumnQueryCompiler { /* ... */ }
```

```ts
// Don't: re-implements the whole insert to change one clause
public compile() { /* copied INSERT assembly with one change */ }

// Do: override the hook that writes that clause
protected autoIncrementPlaceholder(): string { return 'DEFAULT'; }
```

## Examples

### Store timestamps with microseconds

`dateTime()` and `timestamp()` columns are `TIMESTAMPTZ(3)` by default, the precision of a JS `Date`. This compiler keeps the microseconds the server writes itself. The alter-column compiler calls the same `typeExpression()`, so `modify()` uses it too.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ColumnQueryCompiler } from '@spinajs/orm';
import { PostgresColumnQueryCompiler, PostgresOrmDriver } from '@spinajs/orm-postgres';

@NewInstance()
export class MicrosecondColumnCompiler extends PostgresColumnQueryCompiler {
  public typeExpression(): string {
    if (this.builder.Type === 'dateTime' || this.builder.Type === 'timestamp') {
      return 'TIMESTAMPTZ(6)';
    }

    return super.typeExpression();
  }
}

@Injectable('orm-driver-postgres')
@NewInstance()
export class MicrosecondPostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(MicrosecondColumnCompiler).as(ColumnQueryCompiler);
  }
}
```

### Schedule jobs with pg_cron

Replace the two event compilers that throw with compilers that call the [`pg_cron`](https://github.com/citusdata/pg_cron) extension, and declare `events: true`. `schema().createEvent()` and `dropEvent()` then work on PostgreSQL.

```ts sample
import { Container, Inject, Injectable, NewInstance } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { DropEventQueryBuilder, DropEventQueryCompiler, EventQueryBuilder, EventQueryCompiler, ICompilerOutput, ISupportedFeature, LiteralQuoter, RawQuery } from '@spinajs/orm';
import { inlineBindings } from '@spinajs/orm-sql';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

@NewInstance()
@Inject(Container)
export class PgCronEventQueryCompiler extends EventQueryCompiler {
  constructor(protected container: Container, protected builder: EventQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    if (!this.builder.Every) {
      throw new NotSupported('pg_cron schedules recurring jobs only: use every()');
    }

    const literals = this.container.resolve<LiteralQuoter>(LiteralQuoter);
    const body = this.builder.Actions.flatMap((action) => {
      if (action instanceof RawQuery) {
        return [inlineBindings(action.Query, action.Bindings ?? [], literals)];
      }
      const compiled = action.toDB();
      return (Array.isArray(compiled) ? compiled : [compiled]).map((c) => inlineBindings(c.expression as string, c.bindings ?? [], literals));
    }).join('; ');

    return {
      bindings: [this.builder.Table, this.schedule(), body],
      expression: 'SELECT cron.schedule(?, ?, ?)',
    };
  }

  private schedule(): string {
    const { Value, Unit } = this.builder.Every!;

    switch (Unit) {
      case 'SECOND':
        return `${Value} seconds`;
      case 'MINUTE':
        return `*/${Value} * * * *`;
      case 'HOUR':
        return `0 */${Value} * * *`;
      case 'DAY':
        return `0 0 */${Value} * *`;
      default:
        throw new NotSupported(`pg_cron has no ${Unit} interval`);
    }
  }
}

@NewInstance()
@Inject(Container)
export class PgCronDropEventQueryCompiler extends DropEventQueryCompiler {
  constructor(protected container: Container, protected builder: DropEventQueryBuilder) {
    super();
  }

  public compile(): ICompilerOutput {
    // cron.unschedule(name) raises when the job is missing; IF EXISTS filters through cron.job instead
    return this.builder.Exists
      ? { bindings: [this.builder.Table], expression: 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ?' }
      : { bindings: [this.builder.Table], expression: 'SELECT cron.unschedule(?)' };
  }
}

@Injectable('orm-driver-postgres')
@NewInstance()
export class PgCronPostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(PgCronEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(PgCronDropEventQueryCompiler).as(DropEventQueryCompiler);
  }

  public supportedFeatures(): ISupportedFeature {
    return { ...super.supportedFeatures(), events: true };
  }
}

export async function purgeExpiredResetTokensHourly(driver: PgCronPostgresDriver): Promise<void> {
  // SELECT cron.schedule('purge_reset_tokens', '0 */1 * * *', 'DELETE FROM "reset_tokens" WHERE "expires_at" < now()')
  await driver.schema().createEvent('purge_reset_tokens', (event) => {
    event.every(1, 'HOUR').do(RawQuery.create('DELETE FROM "reset_tokens" WHERE "expires_at" < now()'));
  });
}
```

### Reset identities on truncate

`TRUNCATE` keeps identity counters by default. Extend the shared compiler the driver claims and append `RESTART IDENTITY`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ICompilerOutput, TruncateTableQueryCompiler } from '@spinajs/orm';
import { SqlTruncateTableQueryCompiler } from '@spinajs/orm-sql';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

@NewInstance()
export class RestartIdentityTruncateCompiler extends SqlTruncateTableQueryCompiler {
  public compile(): ICompilerOutput {
    const output = super.compile();
    // TRUNCATE TABLE "orders" RESTART IDENTITY
    return { ...output, expression: `${output.expression} RESTART IDENTITY` };
  }
}

@Injectable('orm-driver-postgres-fixtures')
@NewInstance()
export class FixturesPostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(RestartIdentityTruncateCompiler).as(TruncateTableQueryCompiler);
  }
}
```

## Related

- [Extending the driver](06-extending-the-driver.md): driver subclasses, driver strings and the full registration table.
- [Query compilers](../orm-sql/02-query-compilers.md): the shared compilers and their tokens.
- [Extending an existing dialect](../orm-sql/08-extending-an-existing-dialect.md): the same pattern for every SQL dialect.
- [Schema DDL and reflection](04-schema-ddl-and-reflection.md) and [Queries and inserts](03-queries-and-inserts.md): the SQL each compiler writes by default.
