# Transactions

`driver.transaction(cb)` on a SQLite connection runs `BEGIN TRANSACTION`, the callback and `COMMIT` on the writer handle. Nested calls become real SQLite savepoints. The only isolation level is `SERIALIZABLE`.

The lifecycle (commit on resolve, rollback on throw, savepoints, `afterCommit`) belongs to `OrmDriver` and is described in [Transactions](../orm/08-transactions.md). This page covers what the SQLite primitives do.

## How it works

1. `OrmDriver.transaction(cb, options?)` checks `options.isolation` against `SupportedIsolationLevels` (`['SERIALIZABLE']`). Any other level throws `OrmException('isolation level <level> not supported by driver orm-driver-sqlite')` before anything is sent.
2. Outermost call: `supportedFeatures().concurrentTransactions` is `false`, so `OrmDriver.transaction()` first waits for the previous outermost transaction of this connection. `SqliteOrmDriver._begin()` then closes the writer gate, waits for outside statements already sent to the writer to finish (`sqlite3` runs the statements of one handle in parallel, so one of them could otherwise run after `BEGIN`), sends `beginStatement()` (`BEGIN TRANSACTION`) on the writer handle and returns `{ depth: 0 }`. There is no per-transaction connection to carry.
3. The callback runs inside `TransactionStorage`. While it is in scope, `handleFor()` sends every statement, `SELECT`s included, to the writer. A statement issued with no transaction in scope that needs the writer handle — every write, and every read when there is no read pool — waits at the gate.
4. Nested call: `_savepoint()` sends `SAVEPOINT <name>`; success sends `RELEASE <name>`, a throw sends `ROLLBACK TO <name>`. Names (`sp_1`, `sp_2`, ...) are quoted with `escapeIdentifier()`, never bound.
5. The callback resolves: `_commit()` sends `COMMIT`. It throws: `_rollback()` sends `ROLLBACK`; a rollback failure is swallowed and the original error is rethrown.
6. `_dispose()` opens the gate: statements held from other async paths run now, before the `afterCommit` callbacks and before the next queued transaction begins.

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
| Transaction primitives | protected `_begin`, `_commit`, `_rollback`, `_savepoint`, `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose` on the driver instance | `BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, opening the writer gate | none shipped | Override `beginStatement()` to change the opening statement, eg. `BEGIN IMMEDIATE TRANSACTION`. An `_begin()` override must close the writer gate as `SqliteOrmDriver._begin()` does. |
| Isolation levels | `SupportedIsolationLevels`, readonly field | `['SERIALIZABLE']` | | Redeclare in a subclass only if the engine really honours more. |
| Transaction entry | `transaction(cb, options?)`, public, from `OrmDriver` | savepoints when nested, `BEGIN` otherwise | | Override in a subclass to instrument transactions; call `super.transaction()`. Outermost calls are already queued. |

### Transaction primitives: custom implementation

SQLite's plain `BEGIN` is `DEFERRED`: it takes the write lock at the first write, and a transaction that reads first can fail with `SQLITE_BUSY` when it upgrades. `BEGIN IMMEDIATE` takes the write lock up front. Outermost transactions are already queued by the core, so the subclass only changes the statement.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-immediate')
@NewInstance()
export class ImmediateSqliteDriver extends SqliteOrmDriver {
  protected beginStatement(): string {
    return 'BEGIN IMMEDIATE TRANSACTION';
  }
}
```

Use it with `Driver: 'orm-driver-sqlite-immediate'`.

## Important behaviour

- One writer handle, no per-transaction connection. Outermost transactions therefore run one at a time: a second `transaction()` waits until the first has committed or rolled back. Nested calls are savepoints and never wait.
- While a transaction is open, a statement from another async path that needs the writer handle — every write, and every read when there is no read pool (`:memory:`, `Pool.Max` 1) — waits until the transaction ends. It never joins the transaction. A read on a read handle does not wait and sees committed rows only.
- Code inside a transaction must not wait for such a held statement, or for another outermost transaction of the same connection: both wait for this transaction to end, so the callback never resolves.
- `SELECT`s inside a transaction always use the writer, so they see the transaction's own uncommitted writes.
- `BEGIN` is `DEFERRED`. A transaction holds no lock until its first statement that needs one.
- `SupportedIsolationLevels` is `['SERIALIZABLE']`: `sqlite3` outside shared-cache mode serializes access to the file. Other levels are rejected, not ignored.
- DDL is transactional in SQLite: `CREATE TABLE` and `ALTER TABLE` inside a rolled-back transaction are undone.
- A failed `Transaction` statement is an `OrmException` with the `sqlite3` error in `inner` (see [Connection and driver](01-connection.md#errors)).
- The driver never retries a statement, so the core's rule "no retries inside a transaction" holds trivially.

## Best practices

- Keep transactions short and awaited end to end; every other statement of the connection waits on the same handle.
- Keep transactions short: every other outermost transaction and every outside write of the connection waits for the one that is open.
- Use `BEGIN IMMEDIATE` for read-then-write transactions that compete with other processes on the same file.
- Nest with `transaction()` rather than raw `SAVEPOINT` SQL, so `afterCommit` callbacks and rollback of nested work stay correct.

## Patterns and antipatterns

```ts
// Don't: inside a transaction, wait for a write that another request started meanwhile;
// that write is held until this transaction ends, so neither finishes
await driver.transaction(async () => {
  await driver.insert().into('ledger').values({ Amount: 10 });
  await auditWriteStartedByAnotherRequest;
});

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
