# As-of and erasure

## `asOf`

`Model.history().asOf(id, at)` and `row.history().asOf(at)` answer what the row was at an instant, from the last retained entry of the row at or before `at`, by `seq`. Every entry holds the whole row in full mode and the key with every tracked column in column mode, so one entry decides; the entries before it are not read.

| `state` | When | Also returned |
| --- | --- | --- |
| `present` | The deciding entry is an `insert`, `update`, `soft_delete` or `restore` with its payload. A soft-deleted row is `present`, with its soft-delete column set. | `row`: the entry's `after`; `seq`: the entry's. |
| `absent` | The deciding entry is a `delete`, also of a row that was forgotten since: the operation is not payload. | `seq`: the delete's. |
| `absent` | No entry of the row is at or before `at`, the row's first retained entry is its `insert`, and the entity has a retained row change (not a `lost` marker) at or before `at` on the model's connection: the trail covers that instant and the row was not created yet. | `seq: null` |
| `redacted` | The deciding entry was erased by `forget`. | `seq`: the entry's. |
| `unknown` | Nothing retained decides. No entry of the row is at or before `at`, and either the row's first retained entry is not an insert (the row predates tracking, its insert was pruned, or it has no entry at all) or the entity has no retained row change at or before `at`. Or a `lost` event of the entity was recorded after the deciding entry and at or before `at`, so a statement whose rows history could not record may have written the row. | |

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

- The payload of every event of the subject `{ type: <entity>, id }` is blanked on two connections: first the trail's own `connection`, where other producers record in the confirmed or deferred mode, then the model's, where the row's entries are. `forget` runs `audit().trail(name).forget({ type: <entity>, id }, source)` once for each ([Which connections](../audit/08-erasure.md#which-connections)), and once only when the trail's `connection` names the model's connection (`default`, an alias). Two configured connections to one database are two connections here: two erasures and two records. Each event's `data_hash` stays, so a seal over it still verifies.
- The entries are still listed, with `redacted: true`, `before: null`, `after: null` and `changed: []`. Their `seq`, `at`, `op`, `actor`, `onBehalfOf` and `traceId` stay.
- A table trail records an `erasure` event (`kind: 'custom'`, `action: 'erasure'`, `data: { redacted: <count> }`) on each of the two connections, with that connection's count, also when nothing was blanked there: one record when they are the same connection. On a shipping trail the records land where [Erasure](../audit/08-erasure.md) says for a `forget` with that `source`. It is not an entry of the row.
- The id is compared byte for byte: `Invoice.history().forget('ABC')` leaves the history of a row `'ABC '` alone on MySQL and SQL Server too, where before 4.0 it blanked it.
- It returns the number of events it redacted on both. Events of that subject that other producers recorded there (reads, actions) are redacted and counted too.
- `asOf` then answers `redacted` where it answered `present`, and still `absent` after a delete.

A subject has no connection in it. Another model with a table of the same name or the same `entity` records its rows under the same subject. On a third connection that holds the trail's table, `forget` leaves those alone, and that model's `history().of(id)` still shows them. On the trail's own connection they are erased with the row: with the built-in `history` trail on `default`, a `User` on `default` and a `LegacyUser` on `legacy` both on the table `users`, `LegacyUser.history().forget(5)` also blanks the history of `User` 5. Give such models distinct `entity` names.

`audit().trail(name).forget(subject)` without a `source` is the sweep: it blanks the subject on every connection that holds the trail's table, so also the rows of such a model that share the id.

```ts sample
import { audit } from '@spinajs/audit';
import { historyOf } from '@spinajs/orm-history';
import type { ModelBase } from '@spinajs/orm';
import type { Constructor } from '@spinajs/di';

export async function forgetRow(model: Constructor<ModelBase>, id: number): Promise<number> {
  return historyOf(model).forget(id);
}

export async function forgetEverywhere(entity: string, id: string): Promise<number> {
  return audit().trail('history').forget({ type: entity, id });
}
```

Reads keep covering the model's connection only. An error of the trail's `forget` reaches the caller as it is: a trail that cannot be read from the application (`LogAuditStore`, a shipping trail without a reader) refuses it with `AuditNotSupported`, with nothing touched. A trail's own connection without the trail table rejects the call with the driver's error before anything is erased. When the model's connection, erased second, fails after the trail's own was erased, the call rejects with that error, not a count, and the trail's own connection stays blanked and recorded; calling `forget` again is safe, since events already blank are not blanked or counted again. When the model's connection and the trail's own are two connections on one shared PGlite instance (`Options.Shared`), call `forget` outside a transaction on either: the erasure on the other waits for that transaction to end.

What is blanked, kept and never blanked, erasure on a shipping trail and how `verify` reads redactions are the trail's: see [Erasure](../audit/08-erasure.md). `forget` does not delete the row, and does not erase copies outside the trail (logs, backups).
