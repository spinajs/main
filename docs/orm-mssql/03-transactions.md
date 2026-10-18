# Transactions

`MsSqlOrmDriver` implements the transaction primitives of `OrmDriver` with `mssql.Transaction`. `driver.transaction(cb, { isolation })` begins a SQL Server transaction at the requested isolation level, nested calls become `SAVE TRANSACTION` savepoints, and every statement inside the callback runs on the transaction's connection.

## How it works

1. `OrmDriver.transaction(cb, options)` checks `options.isolation` against `SupportedIsolationLevels`; an unlisted level throws `OrmException`. All four levels are listed here.
2. **Outermost call.** `_begin(options)` creates `this._connectionPool.transaction()` and calls `begin()` with the mapped `mssql.ISOLATION_LEVEL`, or with none (the server default, `READ COMMITTED`). It returns an `IMsSqlTransactionContext`: `{ transaction, request: transaction.request(), depth: 0 }`.
3. `OrmDriver` runs `cb` inside `TransactionStorage.run(ctx, ...)`. `executeOnDb()` finds the context there and sends each statement through a new `ctx.transaction.request()`; see [Executing statements](02-executing-statements.md). `ctx.request` runs only the savepoint statements.
4. **Nested call.** With a transaction already in scope, `OrmDriver` names a savepoint `sp_<depth>` and calls `_savepoint()`: `SAVE TRANSACTION [sp_1]`. On success `_releaseSavepoint()` runs, which does nothing: T-SQL has no `RELEASE SAVEPOINT`. On error `_rollbackToSavepoint()` runs `ROLLBACK TRANSACTION [sp_1]` and the error is re-thrown.
5. **End.** A resolved callback calls `_commit()` (`transaction.commit()`). A rejected one calls `_rollback()` (`transaction.rollback()`) and re-throws. `_dispose()` does nothing: `mssql` returns the connection to the pool itself. `afterCommit` callbacks run after commit.

| `ITransactionOptions.isolation` | `mssql.ISOLATION_LEVEL` |
| --- | --- |
| `'READ UNCOMMITTED'` | `READ_UNCOMMITTED` |
| `'READ COMMITTED'` | `READ_COMMITTED` |
| `'REPEATABLE READ'` | `REPEATABLE_READ` |
| `'SERIALIZABLE'` | `SERIALIZABLE` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Transaction primitives | `_begin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose` (protected, on the driver) | `mssql.Transaction` with `SAVE TRANSACTION` / `ROLLBACK TRANSACTION` | | Override in a driver subclass. `_begin()` must return an `IMsSqlTransactionContext`, because `executeOnDb()` reads its `transaction` and the savepoint primitives its `request`. |
| Transaction context | `IMsSqlTransactionContext`, exported interface; the value of `driver.CurrentTransaction` inside a transaction | `{ transaction: mssql.Transaction, request: mssql.Request, depth, afterCommit? }` | | Read it in an `executeOnDb()` override; `transaction.request()` gives a new request on the transaction's connection. |
| Isolation levels | `SupportedIsolationLevels` (public, read-only array) | all four | | Override the property in a subclass to forbid a level on a connection. |

### Transaction context: custom implementation

Read the context in an `executeOnDb()` override to act on statements that run inside a transaction, for example to tag them for the server's activity monitor:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { IMsSqlTransactionContext, MsSqlOrmDriver } from '@spinajs/orm-mssql';

/** Prefixes every statement sent inside a transaction with a comment naming its nesting depth. */
@Injectable('orm-driver-mssql-tx-tagged')
@NewInstance()
export class TaggedTransactionMsSqlDriver extends MsSqlOrmDriver {
  public async executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const tx = this.TransactionStorage.getStore() as IMsSqlTransactionContext | undefined;

    return super.executeOnDb(tx ? `/* tx depth ${tx.depth} */ ${stmt}` : stmt, params, context);
  }
}
```

Register it with `Driver: 'orm-driver-mssql-tx-tagged'` on the connection, or with `DI.register(TaggedTransactionMsSqlDriver).as('orm-driver-mssql')` before `Orm` resolves to use it for every MSSQL connection.

## Important behaviour

- **One request per statement.** `mssql` refuses to declare the same parameter name twice on one request, so each statement takes a new request of the transaction. They all run on the transaction's connection.
- **DDL is transactional.** SQL Server rolls back `CREATE TABLE` and `ALTER TABLE` with the transaction, so `Migration.Transaction.Mode: MigrationTransactionMode.PerMigration` makes a migration atomic.
- **Savepoint names are inlined**, bracket-quoted with `]` doubled, because T-SQL does not accept a savepoint name as a parameter.
- **Releasing a savepoint does nothing.** A savepoint stays reachable until the outer transaction ends.
- **Rollback errors are swallowed.** `OrmDriver` ignores an error from `_rollback()` and re-throws the callback's error.

## Best practices

- Run every statement of a unit of work inside one `driver.transaction()` call; statements outside it run on separate pooled connections.
- Ask for `SERIALIZABLE` only where a range must stay stable, such as a balance check followed by a debit.
- Use `driver.afterCommit()` for side effects such as e-mails; they run only after `COMMIT` succeeds.

## Patterns and antipatterns

```ts
// Don't: two statements outside a transaction run on separate pooled connections, and the first stays when the second fails
await driver.update().in('accounts').update({ Balance: 90 }).where('Id', 1);
await driver.update().in('accounts').update({ Balance: 110 }).where('Id', 2);

// Do
await driver.transaction(async () => {
  await driver.update().in('accounts').update({ Balance: 90 }).where('Id', 1);
  await driver.update().in('accounts').update({ Balance: 110 }).where('Id', 2);
});
```

## Examples

### Record a payment and mark the invoice paid

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function payInvoice(invoiceId: number, amount: number): Promise<void> {
  const driver = DI.get(Orm)!.Connections.get('billing')!;

  await driver.transaction(
    async () => {
      await driver.insert().into('payments').values({ InvoiceId: invoiceId, Amount: amount });
      await driver.update().in('invoices').update({ Status: 'paid' }).where('Id', invoiceId);
    },
    { isolation: 'SERIALIZABLE' },
  );
}
```

### Keep the order when the optional coupon fails

A nested `transaction()` is a savepoint: its failure rolls back only the coupon.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function placeOrder(orderId: number, coupon?: string): Promise<void> {
  const driver = DI.get(Orm)!.Connections.get('billing')!;

  await driver.transaction(async () => {
    await driver.update().in('orders').update({ Status: 'placed' }).where('Id', orderId);

    if (coupon) {
      await driver
        .transaction(async () => {
          await driver.update().in('coupons').update({ UsedBy: orderId }).where('Code', coupon).whereNull('UsedBy');
        })
        .catch(() => undefined);
    }
  });
}
```

## Related

- [Transactions](../orm/08-transactions.md): `transaction()`, `afterCommit()`, isolation levels, and who opens transactions for you.
- [Executing statements](02-executing-statements.md): how a statement gets a request of the transaction.
- [Migrations](../orm/10-migrations.md): `Migration.Transaction.Mode`.
