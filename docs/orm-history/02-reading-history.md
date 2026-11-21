# Reading history

Reads go to the model's trail, restricted to its row changes: `kind: 'data'`, the model's entity, the history operations, and the model's connection, where the events of its writes are. An `erasure` event or a `read` event of the same subject is never an entry.

## On a marked model

A model marked with `@History()` gets `Model.history()` and `row.history()`. A decorator cannot change the type of a class, so the model carries their typing itself: an interface of the same name that extends `TrackedRow`, which TypeScript merges with the class, for the rows, and one `declare static history` line for the class. `declare` members emit nothing, so they are no columns.

```ts sample
import { Model, ModelBase, Primary } from '@spinajs/orm';
import { History } from '@spinajs/orm-history';
import type { HistoryEntry, TrackedModel, TrackedRow } from '@spinajs/orm-history';

export interface Invoice extends TrackedRow {}

@Model('invoice')
@History()
export class Invoice extends ModelBase<Invoice> {
  declare static history: TrackedModel['history'];

  @Primary()
  public Id: number;

  public Status: string;
}

export async function statusChanges(id: number): Promise<readonly HistoryEntry[]> {
  return Invoice.history().of(id, { changed: ['Status'], limit: 50 });
}

export async function timelineOf(invoice: Invoice): Promise<readonly HistoryEntry[]> {
  return invoice.history().entries({ ops: ['update'] });
}
```

`@History()` on a class without the two declarations does not compile (`TS1238 ... Property 'history' is missing in type ...`). A model that is not marked has no `history` member, in its type or at run time (`TS2339`). A `declare history: TrackedRow['history']` line in the class body types the rows as well as the interface does.

## `historyOf`

A model tracked by `registerHistory()` or by an `audit.data.rules` entry has no declarations: its class belongs to another package, or the mark exists only in configuration. `historyOf(Model)` and `historyOf(row)` return the same objects as `Model.history()` and `row.history()`, for any tracked model.

```ts sample
import { Model, ModelBase, Primary } from '@spinajs/orm';
import { historyOf, registerHistory } from '@spinajs/orm-history';

@Model('member')
export class Member extends ModelBase<Member> {
  @Primary()
  public Id: number;
}

registerHistory(Member);

export async function eraseMember(id: number): Promise<number> {
  return historyOf(Member).forget(id);
}

export async function changesOf(member: Member) {
  return historyOf(member).entries();
}
```

`historyOf` of a model that is not tracked throws `HistoryConfigError` (`orm-history: Member is not tracked (no @History and no audit.data.rules match)`) at once; `historyOf(row)` and `row.history()` of a row without a primary key value throw `HistoryConfigError` too.

## Methods

| Model | Row | Returns |
| --- | --- | --- |
| `of(id, query?)` | `entries(query?)` | The entries of one row, oldest first. |
| `since(seq, query?)` | | The entries of the model's rows after `seq`, for a consumer that follows the changes. |
| `byActor(actor, query?)` | | The entries of the model's rows whose `actor` is that principal key (`user:42`). |
| `asOf(id, at)` | `asOf(at)` | The row's state at an instant; see [As-of and erasure](03-as-of-and-erasure.md). |
| `forget(id)` | `forget()` | Erases the row's payloads and returns how many entries it redacted; see [As-of and erasure](03-as-of-and-erasure.md). |

`id` is the primary key value: a string, a number or a bigint (`of(9007199254740993n)` finds the row whose key is that bigint). `HistoryQuery` narrows a list:

| Field | Default | Meaning |
| --- | --- | --- |
| `limit` | 100 | 1 to 1000; anything else is refused with `HistoryConfigError`. |
| `afterSeq` | none | Only entries after this `seq`: the last `seq` of the previous page. |
| `ops` | all | Only these operations; an empty list returns nothing. |
| `from`, `to` | none | Bounds on `at`, both inclusive. |
| `changed` | none | Only entries that changed at least one of these columns; an empty list returns nothing. |

An invalid `Date` for `at`, `from` or `to`, and an `afterSeq` that is not a non-negative integer, are refused with `HistoryConfigError` as well.

- An insert or a delete lists no changed column, so `changed` never returns it; ask for it with `ops`. A redacted entry lists none either. `soft_delete` and `restore` list the soft-delete column.
- `changed` is read from the payload, which the trail cannot filter: the trail is read in pages of 1000 events until `limit` entries match, so a narrow filter over a long history reads all of it.

## `HistoryEntry`

| Field | Meaning |
| --- | --- |
| `seq` | The position of the event in the trail table of the model's connection. |
| `at` | When history recorded the statement, as a `Date` with millisecond precision. |
| `entity`, `id` | The subject: the entity and the primary key as text. |
| `op` | `insert`, `update`, `delete`, `soft_delete`, `restore` or `lost`. |
| `before`, `after`, `changed` | The payload of [The event](01-tracking-models.md#the-event); `null`, `null` and `[]` where the operation has none. |
| `actor`, `onBehalfOf`, `traceId` | Who made the change, the person acting through them when impersonating (else `null`), and the request (else `null`). |
| `redacted` | True after `forget`: `before`, `after` and `changed` are gone, the other fields stay. |

## A change feed

`since(seq)` pages through every change of a model in `seq` order. Keep the last `seq` you processed:

```ts sample
import { historyOf } from '@spinajs/orm-history';
import type { ModelBase } from '@spinajs/orm';
import type { Constructor } from '@spinajs/di';

export async function follow(model: Constructor<ModelBase>, after: number, handle: (op: string, id: string) => Promise<void>): Promise<number> {
  const entries = await historyOf(model).since(after, { limit: 500 });
  for (const e of entries) await handle(e.op, e.id);
  return entries.at(-1)?.seq ?? after;
}
```

`seq` counts per connection: a feed is a feed of one model on its connection.

## Across entities

What one request changed, or every change in a trail, is read from the trail itself, and `toHistoryEntry(event)` turns its row changes into entries (`undefined` for any other event):

```ts sample
import { audit } from '@spinajs/audit';
import { toHistoryEntry } from '@spinajs/orm-history';

export async function changedBy(traceId: string) {
  const events = await audit().trail('history').byTrace(traceId, { source: 'default', kinds: ['data'] });
  return events.flatMap((event) => toHistoryEntry(event) ?? []);
}

export async function everyChange(after: number) {
  const events = await audit().trail('history').since(after, { source: 'default', kinds: ['data'], limit: 1000 });
  return events.flatMap((event) => toHistoryEntry(event) ?? []);
}
```

`source` is the connection of the tracked models: a trail's read without it covers the trail's own `connection` ([Reading the trail](../audit/02-reading-the-trail.md#events-on-several-connections)). The same reads without `toHistoryEntry` return the plain audit events, including the reads and actions other producers recorded about the same subjects; `audit().trail('history').of({ type: 'invoice', id: '17' }, { source: 'default' })` is the audit view of one row. The subject type there is the model's entity: its table name unless `@History({ entity })` names another.

## What throws

| Error | When |
| --- | --- |
| `HistoryConfigError` | The model is not tracked; a row has no primary key value; a query value is out of range. |
| `AuditNotSupported` | The trail has no reader in this application: every method rejects with the trail's error, `audit: trail "logged" (store LogAuditStore) cannot be read from this application (of)`. A trail of `LogAuditStore` cannot be written by history either. |
| `AuditConfigError` | The trail is not configured. |

On a shipping trail, reads see an event once it was shipped ([Shipping](../audit/06-shipping.md)). Reads apply no authorization: an application that exposes them decides who may call them.
