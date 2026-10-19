# Quoting and parameters

How identifiers and literals are written on a PostgreSQL connection, and how the ORM's `?` placeholders become PostgreSQL's `$1..$n`. Use the exported helpers when you write raw SQL for this driver or replace one of its compilers.

## How it works

1. **Identifiers.** Every compiler resolves `IdentifierQuoter` from the driver's container. On this driver it is `DoubleQuoteIdentifierQuoter`, whose `quote(name)` calls `pgEscapeIdentifier(name)`: it wraps the name in `"` and doubles every embedded `"`. `quoteQualified('public.users')` (inherited) quotes each dot-separated part: `"public"."users"`.
2. **Literals.** DDL and view bodies cannot carry bindings, so values are inlined through `LiteralQuoter`, which is `PostgresLiteralQuoter`:
   - `null` / `undefined` → `NULL`; finite numbers and bigints as digits; a non-finite number throws `InvalidArgument`.
   - booleans → `TRUE` / `FALSE` (`quoteBoolean()`).
   - strings → `pg.escapeLiteral(value)` (`quoteString()`): single quotes doubled; a string with a backslash becomes ` E'...'` with the backslash doubled.
   - `Date` and luxon `DateTime` → converted by the connection's `DatetimeValueConverter`, then quoted as a string.
3. **Placeholders.** Compiled DML keeps `?` placeholders and a bindings array. `PostgresOrmDriver._executeOnDbOnce()` calls `toDriverStatement(stmt, params)` before sending:
   - with no bindings, the statement is sent unchanged, so a `?` inside an inlined literal survives;
   - with `n` bindings, the first `n` `?` characters become `$1..$n`, left to right, and any later `?` stays as text.
4. **Internal SQL.** The driver's own statements (`SET search_path`, `SAVEPOINT`) quote names with `pgEscapeIdentifier()`; they never bind identifiers.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Identifier quoter | `IdentifierQuoter`, `@NewInstance()`, injected with `@Autoinject(IdentifierQuoter)` into every compiler and statement of the connection | `DoubleQuoteIdentifierQuoter` | `BacktickIdentifierQuoter` (MySQL, SQLite), `BracketIdentifierQuoter` (MSSQL) | Subclass and override `quote(name)`; register `.as(IdentifierQuoter)` in a driver subclass. |
| Literal quoter | `LiteralQuoter`, `@NewInstance()`, `@Inject(Container)`, injected with `@Autoinject(LiteralQuoter)` into the view compiler and anything else that inlines values | `PostgresLiteralQuoter` | `SqlLiteralQuoter` (ANSI, `1`/`0` booleans), `MySqlLiteralQuoter`, `MsSqlLiteralQuoter` | Subclass and override `quoteString()`, `quoteBoolean()`, `quoteDate()` or `quote()`. |
| `pgEscapeIdentifier(name)` | exported function | | | Call it in raw SQL and custom compilers. |
| `toDriverStatement(stmt, params?)` | exported function, used by `executeOnDb()` | | | Call it when you override `executeOnDb()` and send statements yourself. |
| `toPositionalParameters(stmt)` | exported function | | | Rewrites every `?` regardless of bindings; not used by the driver. Use it only for statements you know contain no literal `?`. |

### Literal quoter: custom implementation

Replace `PostgresLiteralQuoter` when inlined values need a different spelling, for example dates written as typed `TIMESTAMPTZ` literals in view bodies. Register it in a driver subclass after `super.resolve()`; a view compiler is created per view and receives `LiteralQuoter` through `@Autoinject`, so every view on that connection uses it.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { LiteralQuoter } from '@spinajs/orm';
import { PostgresLiteralQuoter, PostgresOrmDriver } from '@spinajs/orm-postgres';
import { DateTime } from 'luxon';

/** Inlines dates as UTC TIMESTAMPTZ literals: TIMESTAMPTZ '2026-10-17T08:00:00.000Z'. */
@NewInstance()
export class UtcTimestampLiteralQuoter extends PostgresLiteralQuoter {
  protected quoteDate(value: Date | DateTime): string {
    const iso = value instanceof Date ? value.toISOString() : value.toUTC().toISO();
    return `TIMESTAMPTZ ${this.quoteString(String(iso))}`;
  }
}

@Injectable('orm-driver-postgres')
@NewInstance()
export class UtcLiteralsPostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(UtcTimestampLiteralQuoter).as(LiteralQuoter);
  }
}
```

## Important behaviour

- Quoted identifiers are case-sensitive in PostgreSQL. The ORM quotes every model column, so a column created as `"CreatedAt"` must be read as `"CreatedAt"`; unquoted `CreatedAt` in raw SQL means `createdat`.
- `toDriverStatement()` skips single-quoted literals, double-quoted identifiers and the jsonb operators `?|` and `?&`. The bare jsonb `?` operator is still indistinguishable from a placeholder; use `jsonb_exists()` in raw SQL that carries bindings.
- `toPositionalParameters()` rewrites every `?`, including those inside string literals.
- `PostgresLiteralQuoter.quote()` throws `InvalidArgument` for objects, arrays and invalid dates; bind them instead.
- The JSON operators `?`, `?|` and `?&` collide with placeholders. In a statement with bindings, the first ones are rewritten as parameters. Use the function forms `jsonb_exists()`, `jsonb_exists_any()` and `jsonb_exists_all()`.

## Best practices

- Quote identifiers in raw SQL with `pgEscapeIdentifier()` (or the connection's `IdentifierQuoter`), not with string templates.
- Bind values in raw DML (`schema().raw(sql, bindings)`, `RawQuery.create(sql, bindings)`); inline only where PostgreSQL forbids parameters (DDL, view bodies).
- Resolve the quoter from the connection (`driver.Container.resolve(IdentifierQuoter)`) in code shared between dialects.

## Patterns and antipatterns

```ts
// Don't: ? inside a JSON operator is taken as a placeholder when the statement has bindings
await driver.schema().raw(`SELECT * FROM "events" WHERE "payload" ? 'retry' AND "tenant" = ?`, [tenantId]);

// Do
await driver.schema().raw(`SELECT * FROM "events" WHERE jsonb_exists("payload", 'retry') AND "tenant" = ?`, [tenantId]);
```

```ts
// Don't: unquoted mixed-case identifiers fold to lower case
await driver.schema().raw(`UPDATE users SET LastLogin = now() WHERE Id = ?`, [id]);

// Do
await driver.schema().raw(`UPDATE ${pgEscapeIdentifier('users')} SET ${pgEscapeIdentifier('LastLogin')} = now() WHERE ${pgEscapeIdentifier('Id')} = ?`, [id]);
```

## Examples

### Grant read access to a reporting role on a configurable schema

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { pgEscapeIdentifier } from '@spinajs/orm-postgres';

export async function grantReporting(schema: string, role: string): Promise<void> {
  const orm = await DI.resolve(Orm);
  const driver = orm.Connections.get('main')!;

  // identifiers cannot be bound; quote them so a name like `sales"; DROP ...` stays one identifier
  await driver.schema().raw(`GRANT USAGE ON SCHEMA ${pgEscapeIdentifier(schema)} TO ${pgEscapeIdentifier(role)}`);
  await driver.schema().raw(`GRANT SELECT ON ALL TABLES IN SCHEMA ${pgEscapeIdentifier(schema)} TO ${pgEscapeIdentifier(role)}`);
}
```

### See exactly what is sent to the server

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { toDriverStatement } from '@spinajs/orm-postgres';

export async function explainSql(): Promise<string> {
  const orm = await DI.resolve(Orm);
  const driver = orm.Connections.get('main')!;

  const compiled = driver.select().from('orders').where('status', 'open').take(20).toDB();
  // SELECT * FROM "orders" WHERE "status" = $1 LIMIT $2
  return toDriverStatement(compiled.expression as string, compiled.bindings as unknown[]);
}
```

## Related

- [Identifier and literal quoting](../orm-sql/04-identifier-and-literal-quoting.md): the quoter contracts and the shared `SqlLiteralQuoter`.
- [Connection and pooling](01-connection-and-pooling.md#how-it-works): where `toDriverStatement()` runs.
- [View compiler hooks](../orm-sql/06-view-compiler-hooks.md): how view bodies are inlined with the `LiteralQuoter`.
