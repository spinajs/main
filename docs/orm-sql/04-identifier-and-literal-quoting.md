# Identifier and literal quoting

Every compiler and statement quotes table, column and alias names through an injected `IdentifierQuoter`, and writes literal values into view and event bodies through a `LiteralQuoter`. This package ships the backtick quoter, the ANSI literal quoter and the escaping helpers; each driver registers the pair that matches its dialect.

## How it works

1. **Registration.** A driver's `resolve()` registers one class `.as(IdentifierQuoter)` and one `.as(LiteralQuoter)` in its container. `SqlDriver` registers neither.
2. **Injection.** Compilers and statements declare `@Autoinject(IdentifierQuoter) public Quoter` (and `@Autoinject(LiteralQuoter) public Literals` where they inline values). DI fills the property from the container the compiler or statement was resolved from, so each connection quotes in its own dialect.
3. **Identifiers.** `Quoter.quote(name)` quotes one name; `Quoter.quoteQualified('schema.table')` quotes each dot-separated part.
4. **Values.** DML values are never quoted: they are bound with `?`. Only bodies the engine stores as text (`CREATE VIEW ... AS`, `CREATE EVENT ... DO`) have their bindings inlined, through `inlineBindings(expression, bindings, Literals)`.
5. **DDL literals.** Enum and set members, comments, charsets, collations and string defaults are written with `escapeStringLiteral()`. Charset and collation names in `CREATE DATABASE` go through `assertCharsetName()` instead.

Errors: no `IdentifierQuoter` registration fails on the first query. `SqlLiteralQuoter.quote()` throws `InvalidArgument` for `NaN`, `Infinity`, an invalid date or an object it cannot write. `inlineBindings()` throws `InvalidOperation` when placeholders and bindings do not match in number.

## Services and extension points

| Service | Role | Default implementation | How to override |
| --- | --- | --- | --- |
| `IdentifierQuoter` (from `@spinajs/orm`) | `quote(name)`, `quoteQualified(name)` | none; `BacktickIdentifierQuoter` (SQLite, MySQL), `BracketIdentifierQuoter` (MSSQL), `DoubleQuoteIdentifierQuoter` (PostgreSQL) | Subclass, implement `quote()`, register `.as(IdentifierQuoter)` in the driver's `resolve()` |
| `LiteralQuoter` (from `@spinajs/orm`) | `quote(value)` writes a value as SQL text | none; `SqlLiteralQuoter` (SQLite), `MySqlLiteralQuoter`, `MsSqlLiteralQuoter`, `PostgresLiteralQuoter` | Subclass `SqlLiteralQuoter`, override `quoteString()`, `quoteBoolean()` or `quoteDate()`, register `.as(LiteralQuoter)` |

### `BacktickIdentifierQuoter`

`quote(name)` returns `` `name` `` with embedded backticks doubled. It is registered by the MySQL and SQLite drivers only; MSSQL and PostgreSQL reject backticks.

### `SqlLiteralQuoter`

| Value | Literal |
| --- | --- |
| `null`, `undefined` | `NULL` |
| finite `number`, `bigint` | the number |
| `NaN`, `Infinity` | throws `InvalidArgument` |
| `boolean` | `quoteBoolean()`: `1` / `0` |
| `string` | `quoteString()`: `'...'` with `'` doubled |
| `Date`, luxon `DateTime` | `quoteDate()`: the connection's `DatetimeValueConverter.toDB()` result, then `quoteString()`; an invalid date throws |
| anything else | throws `InvalidArgument` |

It is `@Inject(Container)`: its constructor takes the container, to resolve the `DatetimeValueConverter`.

Dialect variants: `MySqlLiteralQuoter.quoteString()` uses `mysql.escape()` (backslash escapes); `MsSqlLiteralQuoter` writes `N'...'` and refuses a value containing a backtick; `PostgresLiteralQuoter` uses `pg.escapeLiteral()` and writes `TRUE` / `FALSE`.

### Helper functions

| Export | Use |
| --- | --- |
| `escapeIdentifier(name)` | Backtick-quotes one name. For a driver's own internal SQL in a backtick dialect (savepoint names, schema probes). Compilers do not call it. |
| `escapeQualifiedIdentifier(name)` | `escapeIdentifier()` per dot-separated part. |
| `escapeStringLiteral(value)` | Doubles `'`; returns the value without surrounding quotes. For DDL string literals. |
| `assertCharsetName(name, clause)` | Returns `name` when it matches `[A-Za-z0-9_]+`, else throws `InvalidArgument('invalid <clause> name ...')`. |
| `inlineBindings(expression, bindings, quoter)` | Replaces each `?` with `quoter.quote(binding)`. Skips `?` inside `'...'`, `"..."`, `` `...` `` and `--` / `/* */` comments. A backslash is not an escape and `[...]` is not quoting. |

```ts sample
import { NewInstance } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';

/** ANSI double quotes, for an engine that accepts nothing else. */
@NewInstance()
export class AnsiIdentifierQuoter extends IdentifierQuoter {
  public quote(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }
}
```

Register it in your driver's `resolve()`: `this.Container.register(AnsiIdentifierQuoter).as(IdentifierQuoter)`.

## Important behaviour

- No dialect falls back to another's quoting. A driver without an `IdentifierQuoter` registration fails instead of sending backticks to an engine that rejects them.
- `escapeIdentifier()` is always backticks. Code that must work on any connection resolves `IdentifierQuoter` from `driver.Container` instead.
- `SqlInsertQueryCompiler` emits a `RawQuery` column as is, not through the quoter.
- `SqlAlterTableQueryCompiler` quotes the `DROP COLUMN` name; the history compiler still writes trigger SQL without quoting the names.
- `inlineBindings()` is only as safe as the `LiteralQuoter`: it writes values into SQL text. Use it for bodies the engine stores, never for queries you can bind.
- A `Date` written by `SqlLiteralQuoter` follows the connection's `DatetimeValueConverter`, so a view body and a bound `WHERE` see the same format.

## Best practices

- In compilers and statements, quote through `@Autoinject(IdentifierQuoter)`.
- In services and migrations that write raw SQL, resolve the quoter from the connection: `driver.Container.resolve(IdentifierQuoter)`.
- Override only `quoteString()` (or `quoteBoolean()`) in a new `LiteralQuoter`; keep the number, null and date rules of `SqlLiteralQuoter`.
- Validate names you cannot quote (charset, collation) with `assertCharsetName()` rather than escaping them.

## Patterns and antipatterns

```ts
// Don't: escapeIdentifier() is backticks on every connection
const sql = `SELECT ${escapeIdentifier('Total')} FROM ${escapeIdentifier('orders')}`;

// Do: the connection's own quoter
const q = driver.Container.resolve(IdentifierQuoter);
const sql = `SELECT ${q.quote('Total')} FROM ${q.quote('orders')}`;
```

```ts
// Don't: string concatenation into a view body
schema.createView('paid_orders', (v) => v.as(RawQuery.create(`SELECT * FROM orders WHERE Status = '${status}'`)));

// Do: a binding, inlined by the dialect's LiteralQuoter
schema.createView('paid_orders', (v) => v.as(RawQuery.create('SELECT * FROM orders WHERE Status = ?', [status])));
```

## Examples

### Find invoices whose net total exceeds a threshold, on any connection

```ts sample
import { IdentifierQuoter, OrmDriver, RawQuery } from '@spinajs/orm';

interface InvoiceRow {
  Id: number;
  Total: number;
  Discount: number;
}

export async function invoicesAboveNet(driver: OrmDriver, threshold: number): Promise<InvoiceRow[]> {
  const q = driver.Container.resolve(IdentifierQuoter);

  return await driver
    .select<InvoiceRow[]>()
    .from('invoices')
    .where(RawQuery.create(`${q.quote('Total')} - ${q.quote('Discount')} >= ?`, [threshold]));
}
```

### Write booleans as `TRUE` / `FALSE` in view bodies

```ts sample
import { Container, Inject, Injectable, NewInstance } from '@spinajs/di';
import { LiteralQuoter } from '@spinajs/orm';
import { SqlLiteralQuoter } from '@spinajs/orm-sql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
@Inject(Container)
export class KeywordBooleanLiteralQuoter extends SqlLiteralQuoter {
  protected quoteBoolean(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
  }
}

@Injectable('orm-driver-sqlite-keyword-booleans')
@NewInstance()
export class KeywordBooleanSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(KeywordBooleanLiteralQuoter).as(LiteralQuoter);
  }
}
```

## Related

- [Query compilers](02-query-compilers.md) and [Statements](03-statements.md): the consumers of `IdentifierQuoter`.
- [View compiler hooks](06-view-compiler-hooks.md): where `LiteralQuoter` and `inlineBindings()` write view bodies.
- [Architecture](../orm/12-architecture.md#quoting-and-aliases): the quoting tokens from the core's side.
