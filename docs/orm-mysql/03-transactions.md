# Transactions

`MySqlOrmDriver` implements the transaction primitives of `OrmDriver` on one pooled connection per transaction. `driver.transaction(cb)` commits, rolls back, nests with savepoints and honours all four isolation levels. The API is in [Transactions](../orm/08-transactions.md); this page is what MySQL does underneath.

## How it works

1. **Validate.** `OrmDriver.transaction(cb, options)` checks `options.isolation` against `SupportedIsolationLevels`. MySQL declares `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ` and `SERIALIZABLE`. Any other value throws `OrmException('isolation level <x> not supported by driver orm-driver-mysql')` before a connection is taken.
2. **Begin.** `_begin(options)` takes a connection with `acquire()`, which waits for the connection's `SET time_zone`, when `TimeZone` sends one, and fails when it failed (see [Dates and time zone](01-mysql-driver.md#dates-and-time-zone)). With an isolation level it first runs `SET TRANSACTION ISOLATION LEVEL <level>` on that connection. Then it runs `SET autocommit = 0` and `connection.beginTransaction()`. It resolves an `IMySqlTransactionContext`: `{ connection, depth: 0 }`. A failed `SET TRANSACTION` releases the connection and rejects. A failure after it destroys the connection, because its session is half set, and rejects.
3. **Run.** `transaction()` runs `cb` inside `TransactionStorage.run(ctx, ...)`, an `AsyncLocalStorage`. Every statement on this driver in that async path reaches `executeOnDb()`, finds the context, and runs on `ctx.connection`. The connection is not released after each statement.
4. **Nest.** A `transaction()` call inside the callback takes a savepoint instead: `_savepoint()` runs `` SAVEPOINT `sp_<n>` `` on the same connection. Success runs `` RELEASE SAVEPOINT `sp_<n>` ``; a throw runs `` ROLLBACK TO SAVEPOINT `sp_<n>` `` and re-throws.
5. **Finish.** The callback resolves: `_commit()` calls `connection.commit()`. It throws: `_rollback()` calls `connection.rollback()`; a rollback error is swallowed so the original error surfaces. A `COMMIT` or `ROLLBACK` that succeeds sets `ended` on the context.
6. **Release.** `_dispose()` runs on every path, exactly once. When `ended` is set it sends `SET autocommit = 1` and releases the connection to the pool. When neither `COMMIT` nor `ROLLBACK` succeeded, or the restore fails, it destroys the connection, and the server rolls back what the session still held. Then `afterCommit` callbacks run.

```mermaid
sequenceDiagram
  participant App
  participant D as MySqlOrmDriver
  participant C as Pooled connection
  App->>D: transaction(cb, { isolation: 'SERIALIZABLE' })
  D->>C: acquire()
  D->>C: SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
  D->>C: SET autocommit = 0
  D->>C: beginTransaction()
  App->>D: statements inside cb
  D->>C: query (same connection, no retry)
  App->>D: nested transaction(cb2)
  D->>C: SAVEPOINT `sp_1` ... RELEASE SAVEPOINT `sp_1`
  D->>C: commit() or rollback()
  D->>C: SET autocommit = 1, then release()
  Note over D,C: no COMMIT or ROLLBACK succeeded, or the restore failed: destroy()
```

## Configuration

No transaction keys of its own. `Migration.Transaction.Mode` wraps migrations in transactions; see [DDL is not transactional](06-schema-views-and-events.md#ddl-is-not-transactional).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Transaction primitives | `_begin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose`, `restoreAutocommit` (protected, on the driver) | `MySqlOrmDriver` | | Override in a driver subclass; call `super` to keep the connection handling. |
| Transaction context | `IMySqlTransactionContext` (exported type): `ITransactionContext` plus `connection: PoolConnection`, `rolledBackBy?` and `ended?` | built by `_begin()` | | Read it through `driver.CurrentTransaction` to reach the `mysql2` connection. |
| Isolation levels | `SupportedIsolationLevels` (public, readonly) | all four | | Redeclare in a subclass to forbid a level. |

### Transaction primitives: custom implementation

Override `_begin()` to set session state each transaction needs. This driver sets `innodb_lock_wait_timeout` per transaction, so a transaction that waits on a row lock fails fast instead of holding a pooled connection for the server default of 50 seconds.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ITransactionContext, ITransactionOptions } from '@spinajs/orm';
import { IMySqlTransactionContext, MySqlOrmDriver } from '@spinajs/orm-mysql';

@Injectable('orm-driver-mysql-checkout')
@NewInstance()
export class CheckoutMySqlDriver extends MySqlOrmDriver {
  protected async _begin(options?: ITransactionOptions): Promise<ITransactionContext> {
    const ctx = (await super._begin(options)) as IMySqlTransactionContext;

    await new Promise<void>((resolve, reject) => {
      // SET SESSION applies to the pooled connection, so later users of it inherit the value
      ctx.connection.query('SET SESSION innodb_lock_wait_timeout = 5', (err) => (err ? reject(err) : resolve()));
    });

    return ctx;
  }
}
```

## Important behaviour

- Inside a transaction a statement is never retried. A lost connection fails the transaction; `isRetryableError()` returns `false` while a context is in scope.
- `SET TRANSACTION ISOLATION LEVEL` applies to the next transaction on that connection only. The level does not leak to the next user of the pooled connection.
- `_begin()` calls `acquire()` without timing it: that wait is not in the `orm_pool_acquire_seconds` histogram, and it is not retried. A connection whose `SET time_zone` failed is destroyed and `transaction()` rejects before the callback runs.
- A table lock (`LockTableQueryBuilder`) inside the callback runs `SELECT COUNT(*) FROM <table> FOR UPDATE`, not `LOCK TABLES`, which would commit the open transaction. See [Schema, views and events](06-schema-views-and-events.md).
- A transaction holds one pooled connection from begin to release. Open `Pool.Max` transactions at once and every other statement queues.
- Savepoint names are written through `escapeIdentifier()` from `@spinajs/orm-sql`, because MySQL does not accept them as bound parameters.
- A transaction's connection runs with `autocommit = 0` from begin to release, and it goes back to the pool at `autocommit = 1`. A connection that cannot be restored is destroyed, never pooled: left at 0, it would silently never commit a write of its next user. This costs two round trips per transaction, also for the transaction a statement with session settings runs in. If you change `autocommit` inside the callback yourself, you break the guarantees on this page.
- MySQL commits implicitly before DDL. A `CREATE TABLE` inside the callback commits everything before it and cannot be rolled back. The statements after it run in a new implicit transaction, because autocommit is off. The transaction's `COMMIT` commits them, and a rollback discards them. Before autocommit was switched off, each of them committed on its own.
- **A deadlock ends the whole transaction.** InnoDB rolls the whole transaction back when a statement fails with a deadlock (errno 1213) or a full lock table (1206), and on a lock wait timeout (1205) when the server runs with `innodb_rollback_on_timeout`; any other error undoes the failed statement only. The driver remembers it: if the callback catches that error and goes on, every later statement of the transaction, a nested `transaction()` included, is refused before it is sent with `TransactionAborted` (an `OrmException`; "… was rolled back by MySQL …", the server's error as `inner`), the commit is refused, and `transaction()` rejects with it. Nothing of the transaction is written by statements issued after the error, and no `afterCommit()` callback runs. A nested `transaction()` around the failing statement rethrows the server's error, not the "SAVEPOINT … does not exist" of its rollback. The callback may have issued a statement without awaiting it (in parallel), and that statement may already wait on the connection. After a 1205 under `innodb_rollback_on_timeout`, the same holds for a statement issued while the driver reads that setting. Such a statement is still sent, and its own promise fulfils. Because the session runs with autocommit off, it lands in a new implicit transaction, and the driver's final `ROLLBACK` discards it. An application that catches the deadlock and retries the statement inside the same transaction now gets the refusal on every retry, still with errno 1213 in `inner`: a retry loop must retry the whole `transaction()`, not the statement, and must be bounded (`err instanceof TransactionAborted` tells the refusal from a fresh deadlock). On every 1205 the driver reads `@@innodb_rollback_on_timeout` on that connection, one round trip before the error reaches the callback; a metadata-lock timeout is a 1205 as well and leaves the transaction intact even under that setting, and the driver then refuses the rest of the transaction anyway (fail closed). A killed statement (1317) and `max_execution_time` (3024) undo the statement only; a lost connection fails every later statement and the commit, and the server rolls the transaction back.
- The context follows the async path. Work started with `setTimeout` or an event emitter outside the callback's chain runs outside the transaction.

## Best practices

- Pass `{ isolation }` only when the default `REPEATABLE READ` is wrong for the task, eg. `SERIALIZABLE` for a check-then-insert.
- Keep remote calls out of the callback; queue them with `driver.afterCommit()`.
- Read a row you will change in the same transaction at `SERIALIZABLE`, so InnoDB locks it until commit (see the stock example below).
- Retry a transaction that failed with a deadlock (errno 1213) or a lock wait timeout (1205) as a whole, a bounded number of times. A statement retried inside the same transaction after a deadlock is refused with `TransactionAborted` on every try.

```ts
import { OrmException } from '@spinajs/orm';

// Retry the whole transaction on a lock conflict, a few times at most; never one statement inside it.
const lockConflict = (err: unknown) => err instanceof OrmException && [1213, 1205].includes((err.inner as { errno?: number } | undefined)?.errno ?? 0);

for (let attempt = 1; ; attempt++) {
  try {
    await driver.transaction(async () => {
      await driver.insert().into('orders').values(order);
      await driver.update().in('stock').update({ reserved: order.qty }).where('id', order.itemId);
    });
    break;
  } catch (err) {
    if (attempt === 3 || !lockConflict(err)) throw err;
  }
}
```

## Patterns and antipatterns

```ts
// Don't: Promise.all on one transaction's connection; mysql2 runs them one after another anyway,
// and a failure in one leaves the others running while the transaction rolls back
await driver.transaction(async () => {
  await Promise.all(orders.map((o) => o.update()));
});

// Do
await driver.transaction(async () => {
  for (const o of orders) {
    await o.update();
  }
});
```

## Examples

### Move stock between two warehouses at `SERIALIZABLE`

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

type StockRow = { WarehouseId: number; Quantity: number };

export async function moveStock(productId: number, from: number, to: number, quantity: number) {
  const shop = DI.resolve<OrmDriver>('OrmConnection', ['shop'])!;

  await shop.transaction(
    async () => {
      // under SERIALIZABLE InnoDB turns these reads into shared locks until commit
      const rows = (await shop.select().from('stock').where('ProductId', productId).whereIn('WarehouseId', [from, to])) as StockRow[];
      const source = rows.find((r) => r.WarehouseId === from);
      const target = rows.find((r) => r.WarehouseId === to);

      if (!source || !target || source.Quantity < quantity) {
        throw new Error(`cannot move ${quantity} of product ${productId}`);
      }

      await shop.update().in('stock').update({ Quantity: source.Quantity - quantity }).where({ ProductId: productId, WarehouseId: from });
      await shop.update().in('stock').update({ Quantity: target.Quantity + quantity }).where({ ProductId: productId, WarehouseId: to });
    },
    { isolation: 'SERIALIZABLE' },
  );
}
```

### Log the MySQL thread id of the current transaction

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';
import { IMySqlTransactionContext } from '@spinajs/orm-mysql';

export async function auditedRefund(orderId: number) {
  const shop = DI.resolve<OrmDriver>('OrmConnection', ['shop'])!;

  await shop.transaction(async () => {
    const ctx = shop.CurrentTransaction as IMySqlTransactionContext;
    // matches the Id column of SHOW PROCESSLIST, for tracing a lock in the server
    console.log(`refund ${orderId} runs on MySQL thread ${ctx.connection.threadId}`);

    await shop.update().in('orders').update({ Status: 'refunded' }).where('Id', orderId);
  });
}
```

## Related

- [Transactions](../orm/08-transactions.md): `transaction()`, `afterCommit()`, nesting rules, who opens transactions for you.
- [MySQL driver](01-mysql-driver.md#retries): the retry rules this page suspends inside a transaction.
- [Schema, views and events](06-schema-views-and-events.md#ddl-is-not-transactional): implicit commits.
