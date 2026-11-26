# `@spinajs/orm-history`

Row history of ORM models. A tracked model's inserts, updates and deletes are recorded as `data` events of an audit trail of [`@spinajs/audit`](../audit/README.md), in the transaction of the write: the entry commits and rolls back with the row. The package reads them back as a timeline per row, the state of a row at an instant, a change feed per model, and the changes one principal made, and it erases a row's payloads on request.

Nothing is tracked until a model asks for it: `@History()` on the model, `registerHistory(Model)` for a model of another package, or an `audit.data.rules` entry that names it.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { History } from '@spinajs/orm-history';
import type { TrackedModel, TrackedRow } from '@spinajs/orm-history';

export interface Invoice extends TrackedRow {}

@Connection('default')
@Model('invoice')
@History()
export class Invoice extends ModelBase<Invoice> {
  declare static history: TrackedModel['history'];

  @Primary()
  public Id: number;

  public Status: string;
}

export async function paidOn(id: number, day: Date): Promise<boolean> {
  const timeline = await Invoice.history().of(id, { limit: 50 });
  const then = await Invoice.history().asOf(id, day);
  return timeline.length > 0 && then.state === 'present' && then.row.Status === 'paid';
}
```

`Invoice.update({ Status: 'paid' }).where('Id', 17)` now writes one more row into `orm_history`, the table of the built-in trail `history`, on the model's connection: `{ kind: 'data', action: 'update', subject: { type: 'invoice', id: '17' }, data: { before: { Status: 'draft' }, after: { Id: 17, Status: 'paid' }, changed: ['Status'] } }`.

## Next to `@spinajs/audit`

History is one producer and reader of an audit trail; it adds no table, store or retention of its own.

| Package | Holds |
| --- | --- |
| `@spinajs/orm` | The write capture: one read of the rows before and after each statement, shared by every observer of the write ([Write capture](../orm/25-write-capture.md)). |
| `@spinajs/orm-history` | `@History`, `registerHistory`, `audit.data.rules`, the encoding of a row change as an event, `Model.history()`, `row.history()`, `historyOf()`, `toHistoryEntry()`, `HistoryCoverage`, and the migrations of `orm_history` and `history_coverage` on the default connection. |
| `@spinajs/audit`, `@spinajs/audit-orm` | The trail table, its stores and readers, retention, shipping, sealing and erasure ([audit documentation](../audit/README.md)). |

Everything about where events go, how long they are kept and whether they are sealed is a property of the trail, configured under `audit.trails`.

## Who the actor is

History passes no actor. `audit().record` stamps every event with the `actor`, `onBehalfOf`, `traceId` and `origin` of its `AuditContext`: by default the effective principal of the request (with the person acting through it when impersonating or under `runAs`), the request's trace id and the client address. An application that runs writes outside a request, or knows the actor another way, registers its own `AuditContext`; see [The event](../audit/01-trails-and-guarantees.md#the-event).

## Pages

| Page | What it covers |
| --- | --- |
| [Tracking models](01-tracking-models.md) | `@History`, `registerHistory`, `audit.data.rules`, choosing a trail, migrations, failures, the event shape, unknown insert keys. |
| [Reading history](02-reading-history.md) | `Model.history()`, `row.history()`, `historyOf()`, every read with its limits, many rows at once, change feeds and reads across entities. |
| [As-of and erasure](03-as-of-and-erasure.md) | The answers of `asOf`, what retention does to them, and `forget`. |
| [Limits](04-limits.md) | What is not captured and what a reader must not assume. |
| [Coverage](05-coverage.md) | From when on the history of an entity is complete: `HistoryCoverage`, what moves it, the `history_coverage` table. |

## Related

- [Models](../orm/02-models.md): members a package adds to a model.
- [Write capture](../orm/25-write-capture.md): what the capture reads around a statement.
- [Erasure](../audit/08-erasure.md) and [Limits](../audit/09-limits.md) of the audit trail.
