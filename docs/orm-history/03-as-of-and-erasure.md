# As-of and erasure

## `asOf`

`Model.history().asOf(id, at)` and `row.history().asOf(at)` answer what the row was at an instant, from the last retained entry of the row at or before `at`, by `seq`. Every entry holds the whole row in full mode and the key with every tracked column in column mode, so one entry decides; the entries before it are not read.

| `state` | When | Also returned |
| --- | --- | --- |
| `present` | The deciding entry is an `insert`, `update`, `soft_delete` or `restore` with its payload. A soft-deleted row is `present`, with its soft-delete column set. | `row`: the entry's `after`; `seq`: the entry's. |
| `absent` | The deciding entry is a `delete`, also of a row that was forgotten since: the operation is not payload. | `seq`: the delete's. |
| `absent` | No entry of the row is at or before `at`, the row's first retained entry is its `insert`, and the entity has a retained row change (not a `lost` marker) at or before `at` on the model's connection: the trail covers that instant and the row was not created yet. | `seq: null` |
| `redacted` | The deciding entry was erased by `forget`. | `seq`: the entry's. |
| `unknown` | Nothing retained decides. No entry of the row is at or before `at`, and either the row's first retained entry is not an insert (the row predates tracking, its insert was pruned, or it has no entry at all) or the entity has no retained row change at or before `at`. Or a `lost` event of the entity was recorded after the deciding entry and at or before `at`, so an insert whose keys were not reported may have written the row. | |

```ts sample
import { Model, ModelBase, Primary } from '@spinajs/orm';
import { History } from '@spinajs/orm-history';
import type { TrackedModel, TrackedRow } from '@spinajs/orm-history';

export interface Invoice extends TrackedRow {}

@Model('invoice')
@History()
export class Invoice extends ModelBase<Invoice> {
  declare static history: TrackedModel['history'];

  @Primary()
  public Id: number;

  public Status: string;
}

export async function statusAt(id: number, at: Date): Promise<string> {
  const then = await Invoice.history().asOf(id, at);
  switch (then.state) {
    case 'present':
      return String(then.row.Status);
    case 'absent':
      return then.seq === null ? 'not created yet' : 'deleted';
    case 'redacted':
      return 'erased on request';
    case 'unknown':
      return 'not known';
  }
}
```

- `row` is the stored row: raw column values as JSON, `@Hidden()` and excluded columns left out, no converters applied ([The event](01-tracking-models.md#the-event)). It is not a model.
- `asOf` with the `at` of an entry includes that entry: the trail table keeps `at` to the millisecond on every dialect, which is the precision `asOf` compares with.
- Entries of one instant are ordered by `seq`: the later one decides.

## What pruning does to `asOf`

History keeps no retention of its own. A trail with `retentionDays` loses older events to `pruneAudit()`, which `AuditRetentionTask` of `@spinajs/audit-orm/scheduler` runs on every connection that holds the trail's table ([Retention](../audit/01-trails-and-guarantees.md#retention)). After pruning:

- the newest retained entry of a row still decides every instant from its own on: `asOf` keeps answering for those;
- an instant before the oldest retained row change of the entity answers `unknown`, never a guess: the entry that would decide it is gone. So does an instant before a row's oldest retained entry once the row's insert is pruned.

A model that needs a retention of its own names a trail that has it.

## `forget`

`Model.history().forget(id)` and `row.history().forget()` erase a row's history for a data subject's right to erasure. They are redaction, not deletion:

- The payload of every event of the subject `{ type: <entity>, id }` is blanked in every source of the trail: `forget` runs `audit().trail(name).forget({ type: <entity>, id })` without a `source` ([Which connections](../audit/08-erasure.md#which-connections)). On a table trail that is the trail table on every connection that holds it: the model's connection, where the row's entries are, and the trail's own `connection`, where other producers record in the confirmed or deferred mode, among them. Each event's `data_hash` stays, so a seal over it still verifies.
- The entries are still listed, with `redacted: true`, `before: null`, `after: null` and `changed: []`. Their `seq`, `at`, `op`, `actor`, `onBehalfOf` and `traceId` stay.
- The trail records an `erasure` event (`kind: 'custom'`, `action: 'erasure'`, `data: { redacted: <count> }`) beside the events it redacted. On a table trail that is one per connection, with that connection's count: on the trail's own `connection`, also when nothing was blanked there, and on every other connection where the subject has an event. It is not an entry of the row.
- It returns the number of events it redacted over every source. Events of that subject that other producers recorded in the same trail (reads, actions) are redacted and counted too.
- `asOf` then answers `redacted` where it answered `present`, and still `absent` after a delete.

Reads keep covering the model's connection only. An error of the trail's `forget` reaches the caller as it is: a trail that cannot be read from the application (`LogAuditStore`, a shipping trail without a reader) refuses it with `AuditNotSupported`, and a connection the trail table cannot be looked for on fails it with `AuditWriteFailed` before anything is erased.

```ts sample
import { historyOf } from '@spinajs/orm-history';
import type { ModelBase } from '@spinajs/orm';
import type { Constructor } from '@spinajs/di';

export async function forgetRow(model: Constructor<ModelBase>, id: number): Promise<number> {
  return historyOf(model).forget(id);
}
```

What is blanked, kept and never blanked, erasure on a shipping trail and how `verify` reads redactions are the trail's: see [Erasure](../audit/08-erasure.md). `forget` does not delete the row, and does not erase copies outside the trail (logs, backups).
