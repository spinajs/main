# Transactions

`driver.transaction(cb)` on a SQLite connection runs `BEGIN TRANSACTION`, the callback and `COMMIT` on the writer handle. Nested calls become real SQLite savepoints. The only isolation level is `SERIALIZABLE`.

The lifecycle (commit on resolve, rollback on throw, savepoints, `afterCommit`) belongs to `OrmDriver` and is described in [Transactions](../orm/08-transactions.md). This page covers what the SQLite primitives do.

## How it works

1. `OrmDriver.transaction(cb, options?)` checks `options.isolation` against `SupportedIsolationLevels` (`['SERIALIZABLE']`). Any other level throws `OrmException('isolation level <level> not supported by driver orm-driver-sqlite')` before anything is sent.
2. Outermost call: `SqliteOrmDriver._begin()` waits until no other outermost transaction is open, then sends `BEGIN TRANSACTION` (`QueryContext.Transaction`, writer handle) and returns `{ depth: 0 }`. There is no per-transaction connection to carry.
   - While the transaction is open, a writer statement sent from outside its async scope waits until it ends, so it never joins the transaction.
3. The callback runs inside `TransactionStorage`. While it is in scope, `handleFor()` sends every statement, `SELECT`s included, to the writer.
4. Nested call: `_savepoint()` sends `SAVEPOINT <name>`; success sends `RELEASE <name>`, a throw sends `ROLLBACK TO <name>`. Names (`sp_1`, `sp_2`, ...) are quoted with `escapeIdentifier()`, never bound.
5. The callback resolves: `_commit()` sends `COMMIT`. It throws: `_rollback()` sends `ROLLBACK`; a rollback failure is swallowed and the original error is rethrown.
6. `_dispose()` lets the next outermost transaction and the waiting outside statements run. It runs before `afterCommit` callbacks, so a callback can open a new transaction.

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
| Transaction primitives | protected `_begin`, `_sendBegin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose` on the driver instance | `_begin()` queues, then calls `_sendBegin()` (`BEGIN TRANSACTION`); `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`; `_dispose()` releases the queue | none shipped | Override in a driver subclass, eg. `_sendBegin()` sending `BEGIN IMMEDIATE`; call `super` when overriding `_begin()` or `_dispose()`, or the queue breaks. |
| Isolation levels | `SupportedIsolationLevels`, readonly field | `['SERIALIZABLE']` | | Redeclare in a subclass only if the engine really honours more. |
| Transaction entry | `transaction(cb, options?)`, public, from `OrmDriver` | savepoints when nested, `BEGIN` otherwise | | Override in a subclass to instrument transactions; call `super.transaction()`. |

### Transaction primitives: custom implementation

SQLite's plain `BEGIN` is `DEFERRED`: it takes the write lock at the first write, and a transaction that reads first can fail with `SQLITE_BUSY` when it upgrades because another process holds the file. `BEGIN IMMEDIATE` takes the write lock up front. Override `_sendBegin()`, not `_begin()`: `_begin()` also queues outermost transactions.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ITransactionOptions, QueryContext } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-immediate')
@NewInstance()
export class ImmediateSqliteDriver extends SqliteOrmDriver {
  protected async _sendBegin(_options?: ITransactionOptions): Promise<void> {
    await this.executeOnDb('BEGIN IMMEDIATE TRANSACTION', [], QueryContext.Transaction);
  }
}
```

Use it with `Driver: 'orm-driver-sqlite-immediate'`.

## Important behaviour

- One writer handle, no per-transaction connection. Outermost transactions of one connection run one after another: a second `transaction()` started while one is open waits for it to end.
- Statements for the writer from code **outside** the transaction's async path, issued while it is open, wait until it commits or rolls back, so they never become part of it. Code inside the transaction must not wait for such a statement, or both wait forever.
- `SELECT`s inside a transaction always use the writer, so they see the transaction's own uncommitted writes.
- `BEGIN` is `DEFERRED`. A transaction holds no lock until its first statement that needs one.
- `SupportedIsolationLevels` is `['SERIALIZABLE']`: `sqlite3` outside shared-cache mode serializes access to the file. Other levels are rejected, not ignored.
- DDL is transactional in SQLite: `CREATE TABLE` and `ALTER TABLE` inside a rolled-back transaction are undone.
- A `Transaction` statement that fails raises `OrmException` with the `sqlite3` error in `inner` (see [Connection and driver](01-connection.md#errors)).
- Statements inside a transaction are never retried; a `SQLITE_BUSY` there fails at once and the transaction rolls back.

## Best practices

- Keep transactions short and awaited end to end; every other writer statement of the connection waits for them.
- Use `BEGIN IMMEDIATE` (`ImmediateSqliteDriver`) for read-then-write transactions that compete with other processes on the same file.
- Nest with `transaction()` rather than raw `SAVEPOINT` SQL, so `afterCommit` callbacks and rollback of nested work stay correct.

## Patterns and antipatterns

```ts
// Don't: two transactions for work that belongs together; they run one after another and the
// first commits even when the second fails
await Promise.all([
  driver.transaction(async () => driver.insert().into('ledger').values({ Amount: 10 })),
  driver.transaction(async () => driver.insert().into('ledger').values({ Amount: -10 })),
]);

// Do: one transaction
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
