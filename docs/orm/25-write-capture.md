# Write capture

The write capture hands the rows an insert, update or delete reaches, as they were before and after the statement, to every `WriteObserver` that asks for them. It is the plumbing under row history (`@spinajs/orm-history`) and the authz column changelog. The capture stores nothing and knows no actor: what to do with the rows is the observer's business.

Without a registered observer that is interested in a statement, the capture adds nothing to it: no read, no transaction.

## An observer

An observer is a class registered under `WriteObserver`. `interest()` is asked synchronously for every insert, update and delete of a model; it answers `undefined` for a statement it does not care about, or the columns it wants and whether it needs a transaction. `observe()` gets the rows after the statement ran.

```ts sample
import { Injectable } from '@spinajs/di';
import { ModelBase, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder } from '@spinajs/orm';

class Invoice extends ModelBase {}

@Injectable(WriteObserver)
export class InvoiceStatusLog extends WriteObserver {
  interest(query: QueryBuilder): CaptureInterest | undefined {
    return query.Model === Invoice ? { columns: ['status'], transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    for (const row of write.rows) {
      if (row.before?.status !== row.after?.status) {
        console.log(`${write.kind} invoice ${row.id}: ${String(row.before?.status)} -> ${String(row.after?.status)}`);
      }
    }
  }
}
```

`CapturedWrite` carries the statement's `kind` (`insert`, `update`, `delete`), the builder, the model, the driver the statement ran on (inside its transaction when one is open) and `rows`: one `RowChange` per row the statement reached, unchanged rows included. A `RowChange` has the primary key as text (`id`), `before` (undefined when the row did not exist) and `after` (undefined when the row is gone), each projected to the columns the observer asked for plus the primary key. `columns: '*'` reads the whole row.

The optional `prepare(query)` runs before any capture read, inside the transaction; throwing from it aborts the statement. Throwing from `observe()` rejects the write and rolls it back inside a transaction; without one the statement has already committed (see [Concurrent writers](#concurrent-writers)).

## What is read, and when

`WriteCaptureMiddleware` is a query middleware at order 91. It asks every observer once per statement and reads for all interested ones together: the columns are the union of what they asked for (`'*'` wins), so two observers on one statement never cost a second read. When any of them asks for a transaction and none is open on the connection, the before read, the statement, the after read and every `observe()` run in one.

| Statement | Before the statement | After the statement |
| --- | --- | --- |
| update | one key select with the statement's where clauses (soft-deleted and archived rows included), then the rows by key | the same keys |
| delete | as for an update | the same keys; skipped when `RowsAffected` equals the number of keys |
| insert | nothing; for an upsert (`orIgnore`, `orReplace`, `onDuplicate`) the rows that hold a value it supplies for a conflict column | the keys the insert wrote; for an upsert the rows that hold its conflict values |

An upsert may conflict on other columns than the primary key: `onDuplicate()` without columns takes the model's unique columns, and `orReplace` and `orIgnore` conflict on any unique constraint. Its conflict columns are therefore the primary key, every single-column unique index of the table (read from the driver's `tableIndexes()` and kept until the ORM reloads the table's columns, as after a migration that touched it; a driver without it falls back to the model's `@Index` declarations) and the column named in `onDuplicate(...)`. On PostgreSQL and SQLite an `onDuplicate(column)` conflicts on that column alone (`ON CONFLICT (column)`; any other unique key fails the statement), so there the other unique indexes are not read. The rows that hold a value the upsert supplies for one of them are read before and again after the statement (after it also by the keys found before), so a row it updates is reported as an update with its before values, and a row a replace deletes is reported as gone next to the row it inserted. These reads count against `MaxRows`. When some row of the upsert supplies no value for any conflict column, its key comes from the driver as for a plain insert. An upsert of a table with a unique index over several columns or with an expression or prefix part (`lower(email)`, MySQL's `email(10)`), with an `onDuplicate(...)` target of several columns, or that supplies a conflict value with no key text (a date, a boolean, bytes) reaches the observers with `unknownKeys: true` and no rows: the rows it touched cannot be found column by column. A partial unique index is read as a plain one; the rows outside its condition reach the observers as unchanged rows.

The before and after reads are raw selects on the statement's own connection, so converters and select middlewares never touch the rows, and the values are what the driver returned. Keys are read in chunks of 500.

The key select runs through `CaptureReadScope`. By default it runs as it is; `@spinajs/authz-orm` registers a scope that runs it as `SYSTEM`, so row-level filters do not hide rows the write reaches. `captureReadScope()` returns the registered scope.

The helpers the middleware uses are exported for observers and tests: `writeTargetKeys(query, pk)`, `upsertKeys(query, pk)`, `insertedKeys(query, result, pk)` and `captureKeyText(value)`, which turns a key into the text `RowChange.id` holds (strings, safe integers and bigints; anything else has no key text).

## Concurrent writers

Inside a transaction (the capture's own or the caller's) the key select and the before read of an update or delete are locking reads (`SELECT ... FOR UPDATE` on PostgreSQL and MySQL; SQLite locks the whole database for a write). A locking read returns the latest committed row, also under MySQL `REPEATABLE READ`, where a plain select would return the transaction's older snapshot, so the before values are what the statement overwrites. MSSQL could lock with `WITH (UPDLOCK, ROWLOCK)`, but its dialect offers no row lock clause, so the capture takes none there. The locks have a price and leave gaps:

- The key select takes the row locks the statement would take, earlier and in its own scan order, and holds them until the commit. It can also lock rows the statement never touches (restrictions a middleware after order 91 adds, the `LIMIT` of a delete), and on MySQL the gap locks of its range. Two writers that lock the same rows in another order can deadlock here.
- A row that starts to match the statement's where clauses after the key select (another transaction inserts it, or changes it so that it matches) is changed by the statement but not reported. Only the `SERIALIZABLE` isolation level closes that window.
- The reads of an upsert are not locked: a row another transaction inserts with a conflicting value between the before read and the upsert is reported as inserted, though the upsert updated it.
- Without any transaction (every interested observer asks for none and the caller opened none), the key select, the before read, the statement and the after read are four separate statements, each committed on its own: other writers can change the rows in between, and an observer that throws cannot undo a statement that has already committed.

## Read replicas

The before and after reads are raw `driver.select()` statements, which never leave the primary. The key select is a model select sent with `.onPrimary()`, so an observer that asks for no transaction still never reads a lagging replica.

## Limits

`db.WriteCapture.MaxRows` (default `0`, no limit) refuses a captured statement that reaches more rows, before it runs, with `WriteCaptureLimitExceeded`. For an update or delete the rows are those the key select finds, and the key select reads at most `MaxRows + 1` keys, so the count in the message stops there; for an insert they are the rows it supplies.

```json
{ "db": { "WriteCapture": { "MaxRows": 10000 } } }
```

- The model needs a single-column primary key. A captured write of a model with a composite key fails with `write capture: <Model> needs a single-column primary key, it has <n>`.
- An insert whose keys the driver does not report (a multi-row insert without `RETURNING` on SQLite or MSSQL, an insert split into several statements, an insert builder made without `ModelBase.insert`) reaches the observers with `unknownKeys: true` and no rows. What to do then is the observer's decision.
- An update that writes the primary key reaches the observers with `after: undefined` for the old key, as if the row were gone, and the row under its new key is not reported. An observer that keys its records by the primary key refuses such updates itself.
- The key select copies the where clauses the statement has when the capture runs (order 91): those from its creation and from middlewares of a lower order. Restrictions a later middleware adds (the authz access lists, order 100) and the `LIMIT` of a delete are not in it, so it may find rows the statement leaves alone. They reach the observers as unchanged rows and count against `MaxRows`, and a delete then reads them again after the statement.
- A soft delete of a `@SoftDelete` model is an update of its deleted-at column and reaches the observers as one.

## What the capture does not see

Only statements built on a model reach the capture. It does not see:

- builders without a model: `driver.insert()`, `driver.update()`, `driver.del()`, `insertChunked`, and the rows of a junction table written without a junction model;
- `RawQuery` statements, `driver.execute()` with a compiled expression, `driver.executeOnDb()`, raw SQL and `TRUNCATE`;
- schema builders;
- rows the database changes by itself: foreign-key `ON DELETE CASCADE` or `SET NULL`, and triggers;
- writes of other services to the same database.
