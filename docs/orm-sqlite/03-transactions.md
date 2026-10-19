# Transactions

`driver.transaction(cb)` on a SQLite connection runs `BEGIN TRANSACTION`, the callback and `COMMIT` on the writer handle. Nested calls become real SQLite savepoints. The only isolation level is `SERIALIZABLE`.

The lifecycle (commit on resolve, rollback on throw, savepoints, `afterCommit`) belongs to `OrmDriver` and is described in [Transactions](../orm/08-transactions.md). This page covers what the SQLite primitives do.

## How it works

1. `OrmDriver.transaction(cb, options?)` checks `options.isolation` against `SupportedIsolationLevels` (`['SERIALIZABLE']`). Any other level throws `OrmException('isolation level <level> not supported by driver orm-driver-sqlite')` before anything is sent.
2. Outermost call: `SqliteOrmDriver._begin()` sends `BEGIN TRANSACTION` (`QueryContext.Transaction`, writer handle) and returns `{ depth: 0 }`. There is no per-transaction connection to carry.
3. The callback runs inside `TransactionStorage`. While it is in scope, `handleFor()` sends every statement, `SELECT`s included, to the writer.
4. Nested call: `_savepoint()` sends `SAVEPOINT <name>`; success sends `RELEASE <name>`, a throw sends `ROLLBACK TO <name>`. Names (`sp_1`, `sp_2`, ...) are quoted with `escapeIdentifier()`, never bound.
5. The callback resolves: `_commit()` sends `COMMIT`. It throws: `_rollback()` sends `ROLLBACK`; a rollback failure is swallowed and the original error is rethrown.
6. `_dispose()` does nothing: the driver owns the handle, not the transaction.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Connections[].Migration.Transaction.Mode` | `MigrationTransactionMode` | `None` | `None`, `PerMigration`, `PerRun` | How migrations of this connection are wrapped. SQLite DDL is transactional, so `PerMigration` and `PerRun` roll schema changes back too. |

`ITransactionOptions.isolation` accepts `'SERIALIZABLE'` or nothing.

```ts
{
  Name: 'main',
  Driver: 'orm-driver-sqlite',
  Filename: './data/app.sqlite',
  Migration: { OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Transaction primitives | protected `_begin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose` on the driver instance | `BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, no-op | none shipped | Override in a driver subclass, eg. `_begin()` sending `BEGIN IMMEDIATE`. |
| Isolation levels | `SupportedIsolationLevels`, readonly field | `['SERIALIZABLE']` | | Redeclare in a subclass only if the engine really honours more. |
| Transaction entry | `transaction(cb, options?)`, public, from `OrmDriver` | savepoints when nested, `BEGIN` otherwise | | Override in a subclass to queue or instrument transactions; call `super.transaction()`. |

### Transaction primitives: custom implementation

SQLite's plain `BEGIN` is `DEFERRED`: it takes the write lock at the first write, and a transaction that reads first can fail with `SQLITE_BUSY` when it upgrades. `BEGIN IMMEDIATE` takes the write lock up front. The driver below also queues outermost transactions, because concurrent ones on the single writer handle would otherwise collide (see [Important behaviour](#important-behaviour)).

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ITransactionContext, ITransactionOptions, QueryContext, TransactionCallback } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-immediate')
@NewInstance()
export class ImmediateSqliteDriver extends SqliteOrmDriver {
  private _queue: Promise<unknown> = Promise.resolve();

  public async transaction<R>(cb: TransactionCallback<R>, options?: ITransactionOptions): Promise<R> {
    // nested calls are savepoints of the transaction already running; never queue them
    if (this.CurrentTransaction) {
      return super.transaction(cb, options);
    }

    const run = this._queue.then(() => super.transaction(cb, options));
    this._queue = run.catch(() => undefined);
    return run;
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    await this.executeOnDb('BEGIN IMMEDIATE TRANSACTION', [], QueryContext.Transaction);
    return { depth: 0 };
  }
}
```

Use it with `Driver: 'orm-driver-sqlite-immediate'`.

## Important behaviour

- One writer handle, no per-transaction connection. A second outermost `transaction()` started while one is open sends `BEGIN` inside it and fails with `SQLITE_ERROR: cannot start a transaction within a transaction`, wrapped in `OrmException`.
- Writes from code **outside** the transaction's async path, issued while it is open, run on the same handle and become part of it: they commit or roll back with it.
- `SELECT`s inside a transaction always use the writer, so they see the transaction's own uncommitted writes.
- `BEGIN` is `DEFERRED`. A transaction holds no lock until its first statement that needs one.
- `SupportedIsolationLevels` is `['SERIALIZABLE']`: `sqlite3` outside shared-cache mode serializes access to the file. Other levels are rejected, not ignored.
- DDL is transactional in SQLite: `CREATE TABLE` and `ALTER TABLE` inside a rolled-back transaction are undone.
- A failed `Transaction` statement is an `OrmException` with the `sqlite3` error in `inner` (see [Connection and driver](01-connection.md#errors)).
- The driver never retries a statement, so the core's rule "no retries inside a transaction" holds trivially.

## Best practices

- Keep transactions short and awaited end to end; every other statement of the connection waits on the same handle.
- Serialize outermost transactions yourself when requests can overlap, or use a queuing subclass like `ImmediateSqliteDriver`.
- Use `BEGIN IMMEDIATE` for read-then-write transactions that compete with other processes on the same file.
- Nest with `transaction()` rather than raw `SAVEPOINT` SQL, so `afterCommit` callbacks and rollback of nested work stay correct.

## Patterns and antipatterns

```ts
// Don't: two outermost transactions at once on one SQLite connection; the second BEGIN fails
await Promise.all([
  driver.transaction(async () => driver.insert().into('ledger').values({ Amount: 10 })),
  driver.transaction(async () => driver.insert().into('ledger').values({ Amount: -10 })),
]);

// Do: one transaction for work that belongs together
await driver.transaction(async () => {
  await driver.insert().into('ledger').values({ Amount: 10 });
  await driver.insert().into('ledger').values({ Amount: -10 });
});
```

## Examples

### Place an order and keep it even when the audit row fails

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function placeOrder(orderId: number, cartId: number) {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['main'])!;

  return await driver.transaction(
    async () => {
      await driver.update().in('orders').update({ Status: 'placed' }).where({ Id: orderId });
      await driver.del().from('cart_items').where({ CartId: cartId });

      // nested: a SQLite SAVEPOINT; a failure here rolls back only the audit row
      try {
        await driver.transaction(async () => driver.insert().into('order_audit').values({ OrderId: orderId, Event: 'placed' }));
      } catch {
        await driver.afterCommit(() => console.warn(`order ${orderId} placed without an audit row`));
      }
    },
    { isolation: 'SERIALIZABLE' },
  );
}
```

## Related

- [Transactions](../orm/08-transactions.md): `transaction()`, savepoints, `afterCommit`, isolation levels across drivers.
- [Read handle pool](02-read-pool.md): why statements in a transaction never use read handles.
- [Migrations](../orm/10-migrations.md): `Migration.Transaction.Mode`.
