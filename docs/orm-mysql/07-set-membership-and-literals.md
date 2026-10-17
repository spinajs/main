# Set membership and literal quoting

Three small dialect classes decide how MySQL SQL text is written: `BacktickIdentifierQuoter` quotes names, `MySqlLiteralQuoter` writes values into view and event bodies, and `MySqlInSetStatement` turns `whereInSet()` into `FIND_IN_SET`. Replace one to match a server with a non-default `sql_mode`.

## How it works

### `whereInSet()` and `whereNotInSet()`

1. `query.whereInSet('Roles', ['admin', 'editor'])` resolves `InSetStatement` from the connection container with `[column, values, not, tableAlias]`. MySQL registered `MySqlInSetStatement`.
2. `InSetStatement.values()` turns every value into a string. `null` / `undefined` throws `InvalidArgument('set membership value cannot be null or undefined ...')`; a value containing `,` throws `InvalidArgument('... contains the set delimiter "," ...')`.
3. `build()` writes one `(FIND_IN_SET(?, <column>) > 0)` per value, the column quoted by the injected `IdentifierQuoter`, and binds the value.
4. `combine()` joins them: `OR` for `whereInSet`, `NOT ... AND NOT ...` for `whereNotInSet`. An empty list writes `(1 = 0)`, and `(1 = 1)` for the negation.

```sql
-- whereInSet('Roles', ['admin', 'editor'])
((FIND_IN_SET(?, `Roles`) > 0) OR (FIND_IN_SET(?, `Roles`) > 0))
-- whereNotInSet('Roles', ['admin', 'editor'])
(NOT (FIND_IN_SET(?, `Roles`) > 0) AND NOT (FIND_IN_SET(?, `Roles`) > 0))
```

It works on a native `SET` column and on a `VARCHAR` / `TEXT` column written by `@Set()`'s comma-joined converter.

### Literal quoting

`MySqlLiteralQuoter` extends `SqlLiteralQuoter` and overrides `quoteString()` with `mysql2`'s `mysql.escape()`. MySQL reads a backslash inside a string literal as an escape, so doubling quotes is not enough:

| Value | Literal |
| --- | --- |
| `it's` | `'it\'s'` |
| `a\b` | `'a\\b'` |
| `'; DROP TABLE x; --` | `'\'; DROP TABLE x; --'` |
| `true` / `false` | `1` / `0` |
| `null` | `NULL` |
| `Date`, luxon `DateTime` | the connection's `DatetimeValueConverter` output, quoted |

It is used where values cannot be bound: view bodies (`inlineBindings()`) and event comments and bodies. Regular queries bind values as `?`.

### Identifier quoting

`BacktickIdentifierQuoter` writes `` `name` `` and doubles a backtick inside the name. Every compiler and statement takes it through `@Autoinject(IdentifierQuoter)`.

## Configuration

No keys. The server's `sql_mode` decides whether the stock literal quoter is right:

| `sql_mode` flag | Effect on `MySqlLiteralQuoter` |
| --- | --- |
| default | correct |
| `NO_BACKSLASH_ESCAPES` | wrong: a backslash is a literal character, so `'a\\b'` stores two backslashes. Register `SqlLiteralQuoter` instead (example below). |
| `ANSI_QUOTES` | identifiers in backticks still work; double quotes become identifiers, which neither quoter writes |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Set membership | `InSetStatement`; `@NewInstance()`, constructor `(column, values, not, tableAlias)`; resolved per `whereInSet()` | `MySqlInSetStatement` (not exported) | `SqlInSetStatement` (portable `LIKE`, from `@spinajs/orm-sql`) | Extend `InSetStatement` or `SqlInSetStatement`, implement `build()` and `clone()`, register `.as(InSetStatement)`. |
| Literal quoter | `LiteralQuoter`; `@NewInstance() @Inject(Container)` | `MySqlLiteralQuoter` (not exported) | `SqlLiteralQuoter` (ANSI: doubles `'` only) | Extend `SqlLiteralQuoter`, override `quoteString()`, `quoteBoolean()` or `quoteDate()`; register `.as(LiteralQuoter)`. |
| Identifier quoter | `IdentifierQuoter` | `BacktickIdentifierQuoter` | `DoubleQuoteIdentifierQuoter`, `BracketIdentifierQuoter` | Register another quoter `.as(IdentifierQuoter)`; every compiler picks it up. |

Register each replacement in a driver subclass's `resolve()`, after `super.resolve()`.

### Literal quoter: custom implementation

On a server running with `NO_BACKSLASH_ESCAPES`, backslash escaping corrupts view bodies. The shared `SqlLiteralQuoter` doubles single quotes and leaves backslashes alone, which is what that mode expects.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { LiteralQuoter } from '@spinajs/orm';
import { SqlLiteralQuoter } from '@spinajs/orm-sql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

@Injectable('orm-driver-mysql-ansi')
@NewInstance()
export class NoBackslashEscapesMySqlDriver extends MySqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqlLiteralQuoter).as(LiteralQuoter);
  }
}
```

### Set membership: custom implementation

Match set members case-insensitively, for a `Tags` column filled from user input in mixed case. `clone()` must copy the injected quoter and the `Boolean` connector, or a cloned query loses them.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, InSetStatement, IQueryStatement, IQueryStatementResult } from '@spinajs/orm';
import { _columnWrap } from '@spinajs/orm-sql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';
import { Autoinject } from '@spinajs/di';

@NewInstance()
export class CaseInsensitiveInSetStatement extends InSetStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._tableAlias);
    const values = this.values().map((v) => v.toLowerCase());

    return {
      Bindings: values,
      Statements: [this.combine(values.map(() => `(FIND_IN_SET(?, LOWER(${column})) > 0)`))],
    };
  }

  public clone(): IQueryStatement {
    const copy = new CaseInsensitiveInSetStatement(this._column, this._val, this._not, this._tableAlias!);
    copy.Quoter = this.Quoter;
    copy.Boolean = this.Boolean;
    return copy;
  }
}

@Injectable('orm-driver-mysql')
@NewInstance()
export class CaseInsensitiveSetsMySqlDriver extends MySqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(CaseInsensitiveInSetStatement).as(InSetStatement);
  }
}
```

## Important behaviour

- `FIND_IN_SET` cannot use an index: a `whereInSet()` filter scans every row it reaches.
- A set value cannot contain `,`; the statement throws instead of matching neighbouring members.
- `MySqlInSetStatement.clone()` copies the column, values, negation, alias and quoter, but not the `Boolean` connector; copy it in your own statement's `clone()`.
- `MySqlLiteralQuoter` only writes values into SQL that the server stores (views, events). It is not a substitute for bindings.

## Best practices

- Prefer a join table over `@Set()` when you filter by membership on large tables.
- Keep set members free of commas and spaces; `FIND_IN_SET` compares whole members.
- Run `SELECT @@sql_mode` once per environment; a managed MySQL may enable `NO_BACKSLASH_ESCAPES` or `ANSI_QUOTES`.

## Patterns and antipatterns

```ts
// Don't: a LIKE on a comma-joined column matches 'superadmin' for 'admin'
query.where('Roles', 'like', '%admin%');

// Do: membership of the whole member
query.whereInSet('Roles', ['admin']);
```

## Examples

### Find editors who are not suspended

```ts sample
import { Connection, Model, ModelBase, Primary, Set } from '@spinajs/orm';

@Connection('shop')
@Model('users')
export class ShopUser extends ModelBase<ShopUser> {
  @Primary()
  public Id: number;

  public Email: string;

  @Set()
  public Roles: string[];
}

export async function activeEditors() {
  // WHERE ((FIND_IN_SET(?, `Roles`) > 0)) AND (NOT (FIND_IN_SET(?, `Roles`) > 0))
  return await ShopUser.query().whereInSet('Roles', ['editor']).whereNotInSet('Roles', ['suspended']);
}
```

## Related

- [Identifier and literal quoting](../orm-sql/04-identifier-and-literal-quoting.md): the quoter contracts and helpers.
- [Statements](../orm-sql/03-statements.md): `InSetStatement`, `combine()` and the `clone()` contract.
- [Converters and hydration](../orm/04-converters-and-hydration.md): `@Set()` and how set columns are written.
- [Schema, views and events](06-schema-views-and-events.md): where literals are inlined.
