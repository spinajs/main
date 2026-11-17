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

The optional `prepare(query)` runs before any capture read, inside the transaction; throwing from it, or from `observe()`, aborts the statement and rolls it back when the capture opened the transaction.

## What is read, and when

`WriteCaptureMiddleware` is a query middleware at order 91. It asks every observer once per statement and reads for all interested ones together: the columns are the union of what they asked for (`'*'` wins), so two observers on one statement never cost a second read. When any of them asks for a transaction and none is open on the connection, the before read, the statement, the after read and every `observe()` run in one.

| Statement | Before the statement | After the statement |
| --- | --- | --- |
| update | one key select with the statement's where clauses (soft-deleted and archived rows included), then the rows by key | the same keys |
| delete | as for an update | the same keys; skipped when `RowsAffected` equals the number of keys |
| insert | nothing; for an upsert (`orIgnore`, `orReplace`, `onDuplicate`) the rows that hold a value it supplies for a conflict column | the keys the insert wrote; for an upsert the rows that hold its conflict values |

An upsert may conflict on other columns than the primary key: `onDuplicate()` without columns takes the model's unique columns, and `orReplace` and `orIgnore` conflict on any unique constraint. Its conflict columns are therefore the primary key, every column the model descriptor marks unique and the columns named in `onDuplicate(...)`. The rows that hold a value the upsert supplies for one of them are read before and again after the statement, so a row it updates is reported as an update with its before values, and a row a replace deletes is reported as gone next to the row it inserted. When some row of the upsert supplies no value for any conflict column, its key comes from the driver as for a plain insert. A unique constraint over several columns is not marked on a single column: such a conflict is only seen when the row also matches by the primary key or by a unique column.

The before and after reads are raw selects on the statement's own connection, so converters and select middlewares never touch the rows, and the values are what the driver returned. Keys are read in chunks of 500.

The key select runs through `CaptureReadScope`. By default it runs as it is; `@spinajs/authz-orm` registers a scope that runs it as `SYSTEM`, so row-level filters do not hide rows the write reaches. `captureReadScope()` returns the registered scope.

The helpers the middleware uses are exported for observers and tests: `writeTargetKeys(query, pk)`, `upsertKeys(query, pk)`, `insertedKeys(query, result, pk)` and `captureKeyText(value)`, which turns a key into the text `RowChange.id` holds (strings, safe integers and bigints; anything else has no key text).

## Read replicas

The before and after reads are raw `driver.select()` statements, which never leave the primary. The key select is a model select sent with `.onPrimary()`, so an observer that asks for no transaction still never reads a lagging replica.

## Limits

`db.WriteCapture.MaxRows` (default `0`, no limit) refuses a captured statement that reaches more rows, before it runs, with `WriteCaptureLimitExceeded`:

```json
{ "db": { "WriteCapture": { "MaxRows": 10000 } } }
```

- Only writes made through the ORM builders are captured. Raw SQL, `TRUNCATE`, `driver.executeOnDb()` and other services that write to the database are not.
- The model needs a single-column primary key. A captured write of a model with a composite key fails with `write capture: <Model> needs a single-column primary key, it has <n>`.
- An insert whose keys the driver does not report (a multi-row insert without `RETURNING` on SQLite or MSSQL, an insert builder made without `ModelBase.insert`) reaches the observers with `unknownKeys: true` and no rows. What to do then is the observer's decision.
