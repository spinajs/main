# View compiler hooks

`SqlCreateViewQueryCompiler` renders `CREATE VIEW` from one hook per clause. The base class emits only the portable core and throws for every optional clause, so a driver overrides the hook of each clause its engine supports. `SqlDriver` does not register it: every driver registers its own subclass as `CreateViewCompiler`.

## How it works

1. `driver.schema().createView(name, callback)` builds a `CreateViewQueryBuilder` and runs the callback: `orReplace()`, `ifNotExists()`, `temporary()`, `columns()`, `algorithm()`, `security()`, `checkOption()`, `as(body)`.
2. Awaiting it calls `toDB()`, which resolves `CreateViewCompiler` from the connection container with `[builder]`.
3. `compile()` calls the hooks in clause order and joins the non-empty parts with spaces:

   ```
   CREATE <_replace> <_temporary> <_prefixOptions> VIEW <_ifNotExists> <_name> <_columns> <_withOptions> AS <_body> <_checkOption>
   ```

4. `_body()` compiles a select builder (or takes a `RawQuery`) and writes its bindings into the text with `inlineBindings()` and the connection's `LiteralQuoter`. A view body has no placeholders: the engine stores it as text.
5. The result is one `ICompilerOutput` with no bindings, sent with `QueryContext.Schema`.

Errors: a hook for a clause the engine lacks throws `MethodNotImplemented('<Engine> does not support <clause> on CREATE VIEW')`. A view without `as()` throws `InvalidOperation('view <name> has no body, call as() first')`.

## Services and extension points

| Hook | Builder state | Base behaviour |
| --- | --- | --- |
| `_replace()` | `Replace` (`orReplace()`) | throws `OR REPLACE` |
| `_temporary()` | `Temporary` (`temporary()`) | throws `TEMPORARY` |
| `_prefixOptions()` | `Algorithm`, `Security` | throws `ALGORITHM` / `SQL SECURITY` when set; clauses between `CREATE` and `VIEW` |
| `_ifNotExists()` | `IfNotExists` | throws `IF NOT EXISTS` |
| `_name()` | table, database | `TableAliasCompiler.compile(builder)` |
| `_columns()` | `Columns` | `(`a`,`b`)` through `IdentifierQuoter`, or nothing |
| `_withOptions()` | | `''`; clauses between the column list and `AS` |
| `_body()` | `Body` | compiled select or raw query, bindings inlined |
| `_checkOption()` | `CheckOption` (`true`, `'CASCADED'`, `'LOCAL'`) | throws `CHECK OPTION` |
| `checkOptionSql()` | `CheckOption` | helper: `WITH CHECK OPTION` or `WITH <CASCADED|LOCAL> CHECK OPTION` |
| `unsupported(clause)` | | helper: throws `MethodNotImplemented` naming `Engine` |
| `Engine` | | `'this database engine'`; set it to your engine's name for the error messages |

The class is `@NewInstance() @Inject(Container)`: the constructor is `(container, builder)`, and it carries `@Autoinject(IdentifierQuoter) Quoter` and `@Autoinject(LiteralQuoter) Literals`.

What each shipped driver overrides:

| Driver class | `Engine` | Overrides |
| --- | --- | --- |
| `SqliteCreateViewCompiler` | `sqlite` | `_temporary()` returns `TEMP`, `_ifNotExists()` returns `IF NOT EXISTS` |
| `MySqlCreateViewCompiler` | `mysql` | `_replace()` returns `OR REPLACE`, `_prefixOptions()` writes `ALGORITHM=...` and `SQL SECURITY ...`, `_checkOption()` uses `checkOptionSql()` |
| `MsSqlCreateViewCompiler` | `mssql` | `_replace()` returns `OR ALTER`, `_name()` refuses a database prefix, `_checkOption()` allows only plain `WITH CHECK OPTION` |
| `PostgresCreateViewCompiler` | `postgres` | `OR REPLACE`, `TEMPORARY`, `WITH (security_invoker = ...)` from `security()`, `checkOptionSql()` |

```ts sample
import { Container, Inject, NewInstance } from '@spinajs/di';
import { SqlCreateViewQueryCompiler } from '@spinajs/orm-sql';

/** An engine with CREATE OR REPLACE VIEW and every CHECK OPTION form, but no temporary views. */
@NewInstance()
@Inject(Container)
export class AnsiCreateViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'ansidb';

  protected _replace(): string {
    return this.builder.Replace ? 'OR REPLACE' : '';
  }

  protected _checkOption(): string {
    return this.checkOptionSql();
  }
}
```

Register it in your driver's `resolve()`: `this.Container.register(AnsiCreateViewCompiler).as(CreateViewCompiler)`.

## Important behaviour

- A clause no hook implements fails loudly instead of sending another dialect's syntax.
- Body bindings are inlined as literals by the connection's `LiteralQuoter`; a replaced `LiteralQuoter` changes view bodies. See [Identifier and literal quoting](04-identifier-and-literal-quoting.md).
- `as(callback)` creates its select builder with `new SelectQueryBuilder(...)`, not through DI: a builder subclass registered for the connection does not apply to view bodies.
- `algorithm()`, `security()` and `checkOption(option)` validate their argument in the builder (`'UNDEFINED' | 'MERGE' | 'TEMPTABLE'`, `'DEFINER' | 'INVOKER'`, `'CASCADED' | 'LOCAL'`), before any hook runs.
- `DROP VIEW` is a different token, `DropViewCompiler`, bound by `SqlDriver` to `SqlDropViewQueryCompiler`.

## Best practices

- Override only the hooks of clauses your engine has; leave the rest throwing.
- Return `''` from a hook when its builder flag is not set; `compile()` drops empty parts.
- Set `Engine` so a user who asks for an unsupported clause reads which engine refused it.

## Patterns and antipatterns

```ts
// Don't: silently ignoring a requested clause creates a different view than asked for
protected _checkOption(): string {
  return '';
}

// Do: render it, or let the base class refuse it
protected _checkOption(): string {
  return this.checkOptionSql();
}
```

## Examples

### Create a view of paid invoices

```ts sample
import { OrmDriver } from '@spinajs/orm';

export async function createPaidInvoicesView(driver: OrmDriver): Promise<void> {
  await driver.schema().createView('paid_invoices', (view) => {
    view
      .columns(['Id', 'Number', 'Total'])
      .as((select) => {
        select.columns(['Id', 'Number', 'Total']).from('invoices').where('Status', 'paid');
      });
  });
}
```

On SQLite this sends ``CREATE VIEW `paid_invoices` (`Id`,`Number`,`Total`) AS SELECT `Id`,`Number`,`Total` FROM `invoices` WHERE `Status` = 'paid'``.

## Related

- [Query compilers](02-query-compilers.md): the other compiler tokens.
- [Schema builder](../orm/09-schema-builder.md): `createView()` and the view builder methods.
- [Adding a new SQL dialect](07-adding-a-sql-dialect.md): registering the view compiler in a new driver.
