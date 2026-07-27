# `@spinajs/orm-sql` documentation

The generic SQL layer. `@spinajs/orm` deliberately contains no SQL — it declares statement and
compiler classes as **abstract** and resolves them from the connection's DI container. This
package provides the concrete, dialect-neutral implementations, plus `SqlDriver`, the base class
every dialect driver extends.

You rarely install it directly; it arrives as a dependency of `@spinajs/orm-sqlite`,
`@spinajs/orm-mysql` or `@spinajs/orm-mssql`.

## Pages

| | Page | Covers |
| --- | --- | --- |
| 01 | [Overview](01-overview.md) | Where this package sits, `SqlDriver`, what it registers |
| 02 | [Compilers](02-compilers.md) | Every compiler and the SQL it emits |
| 03 | [Statements](03-statements.md) | Every statement class and its build rules |
| 04 | [Writing a driver](04-writing-a-driver.md) | Building a new dialect on top of `SqlDriver` |

## Related

- [`@spinajs/orm`](../../orm/docs/) — the core; start there
- [`@spinajs/orm/docs/12-architecture.md`](../../orm/docs/12-architecture.md) — how a query
  becomes SQL, end to end
