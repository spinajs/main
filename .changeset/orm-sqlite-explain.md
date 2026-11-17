---
"@spinajs/orm": major
"@spinajs/orm-sql": minor
"@spinajs/orm-sqlite": minor
---

Breaking for code that passes or assigns the protected `OrmDriver.TransactionStorage` where an `AsyncLocalStorage<ITransactionContext>` is expected: the field is now an `AsyncLocalStorage<ITransactionContext | undefined>`, so that the new `OrmDriver.outsideTransaction()` can run a callback with no transaction in scope; widen that type to `AsyncLocalStorage<ITransactionContext | undefined>`. A subclass that redeclares the field with the old type still compiles, and `getStore()` and `run(ctx, …)` are called as before.

`SqliteOrmDriver.explain()` plans a read statement with `EXPLAIN QUERY PLAN` and returns a nested `PlanNode` tree (`normalizeSqlitePlan`), so slow-query records on sqlite carry plans. `SqlDriver.runExplain()` is what every dialect uses for this: it accepts only a single `SELECT`/`WITH` statement, binds the values as parameters, and runs outside the transaction in scope, so it must not be awaited inside a transaction on a driver without concurrent transactions.
