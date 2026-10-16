# Transactions

`OrmDriver.transaction(callback, options?)` owns the whole lifecycle: it commits when the
callback resolves, rolls back when it throws, and releases the connection exactly once on every
exit path. It resolves with whatever the callback returned.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function basic() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  const total = await driver.transaction(async () => {
    await driver.insert().into('audit').values({ Message: 'start' });
    await driver.update().in('counters').update({ Value: 1 }).where('Key', 'runs');

    return 42; // becomes the result of transaction()
  });

  return total;
}
```

## The ambient connection

Statements issued inside the callback run on that transaction's connection **automatically**.
The per-transaction context is carried through `AsyncLocalStorage`, so nothing has to be threaded
by hand — this is why the callback's `driver` argument is usually ignored.

The context lives on the abstract `OrmDriver`, not in any one driver, so the guarantee is part
of the contract that every driver inherits.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver, ITransactionContext } from '@spinajs/orm';

export function inspect() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  // undefined outside a transaction.
  const ctx: ITransactionContext | undefined = driver.CurrentTransaction;

  return ctx?.depth;
}
```

`ITransactionContext` carries `connection` (the driver's own handle, absent for single-handle
drivers like SQLite), `depth` (savepoints taken so far, 0 at the outermost level), and
`IdentityMap` — created lazily by the first `save()` inside the transaction and discarded with
it.

## Nesting takes savepoints

Calling `transaction()` while one is already in scope on this async path does **not** open a
second, independent transaction. It takes a savepoint named `sp_<depth>`, so a failing nested
block rolls back only its own work and the enclosing transaction survives.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('accounts')
export class Account extends ModelBase<Account> {
  @Primary()
  public Id: number;

  public Balance: number;

  public Note: string;
}

export async function nested() {
  return await Account.transaction(async () => {
    const account = await Account.getOrFail(1);
    account.Balance -= 100;
    await account.update();

    try {
      // A savepoint, not a new transaction.
      await Account.transaction(async () => {
        account.Note = 'optional bookkeeping';
        await account.update();
        throw new Error('this part failed');
      });
    } catch {
      // Only the inner block was rolled back. The balance change is still pending.
    }

    return account.Balance;
  });
}
```

This is why `save()`, `Relation.sync()` and `SingleRelation.set()` can each open a transaction
without stepping on a caller who already opened one.

## Isolation levels

`ITransactionOptions.isolation` accepts `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`
and `SERIALIZABLE`. Which of these a driver honours is declared per driver in
`SupportedIsolationLevels`, and requesting an unlisted one is **rejected rather than silently
ignored**:

```
isolation level SERIALIZABLE not supported by driver orm-driver-x
```

| Driver | Supported levels |
| --- | --- |
| MySQL | all four |
| MSSQL | all four |
| SQLite | `SERIALIZABLE` only — sqlite3 outside shared-cache mode serializes file access, which is SERIALIZABLE and nothing else |

A driver that declares nothing rejects every explicitly requested level. Omitting `isolation`
always works.

Nested calls ignore `isolation`: they map onto savepoints inside the enclosing transaction and
inherit its isolation.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function isolated() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  return await driver.transaction(
    async () => {
      return await driver.select().from('ledger').where('Posted', false);
    },
    { isolation: 'REPEATABLE READ' },
  );
}
```

## From a model

`Model.transaction(callback)` runs on that model's connection.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Reference: string;

  public Status: string;
}

export async function place(reference: string) {
  return await Order.transaction(async () => {
    const order = new Order({ Reference: reference, Status: 'new' });
    await order.insert();
    return order.Id;
  });
}
```

## Rollback semantics

On a throw the driver rolls back and re-throws the original error. A **rollback failure is
swallowed** so it cannot mask whatever actually went wrong. `_dispose` then runs in a `finally`,
so the connection is released exactly once whichever path was taken.

Note that a rollback undoes the *database* work only. In-memory model state is not reverted —
a model whose `insert()` succeeded inside a rolled-back transaction still holds the key the
database assigned, and that key no longer exists. Re-read or discard such instances.

## What is already transactional

Several ORM operations open a transaction internally, and all of them nest correctly:

| Operation | Why |
| --- | --- |
| `model.save()` | The whole graph must apply atomically. |
| `Relation.sync()` | The writes and the orphan delete used to be independent statements. |
| `Relation.update()` | Same, for the write half. |
| `SingleRelation.set()` | The attach and the owner update cannot half-apply. |
| `SingleRelation.remove()` | Deleting the target and clearing the foreign key cannot half-apply. |
| A migration | Only with `Migration.Transaction.Mode = PerMigration`. |

## Driver contract

A driver implements six primitives; `transaction()` orchestrates them.

| Method | Responsibility |
| --- | --- |
| `_begin(options?)` | Open a transaction, return its context. Pooled drivers acquire a connection here. |
| `_commit(ctx)` | Commit. |
| `_rollback(ctx)` | Roll back. |
| `_savepoint(ctx, name)` | Take a named savepoint. |
| `_releaseSavepoint(ctx, name)` | The nested block succeeded; fold its changes in. |
| `_rollbackToSavepoint(ctx, name)` | Discard everything since the savepoint. |
| `_dispose(ctx)` | Release whatever `_begin` acquired. Called exactly once, on every path. |

## Retries and transactions

`withReconnect` never retries inside a transaction. The connection carried uncommitted state;
reconnecting and replaying one statement would silently apply it **outside** the transaction. The
error surfaces instead. See [13-observability.md](13-observability.md).
