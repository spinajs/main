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

`@History()` on a class without the two declarations does not compile (`TS1238 ... Property 'history' is missing in type ...`). A model tracked by `registerHistory()` has the members at run time but not in its type (`TS2339`), and a model that is only matched by a rule has neither; use `historyOf` for both. A `declare history: TrackedRow['history']` line in the class body types the rows as well as the interface does.

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
| `since(seq, query?)` | | The entries of the model's rows after `seq`, for a consumer that follows the changes, and the entity's `lost` markers. |
| `byActor(actor, query?)` | | The entries of the model's rows whose `actor` is that principal key (`user:42`), and the entity's `lost` markers recorded under that actor. |
| `latestBefore(ids, at)`, `latest(ids)` | | The last entry of each of many rows, at or before an instant or at all; see [Many rows at once](#many-rows-at-once). |
| `current(ids)`, `currentWhere(where, limit)` | | The current rows, each as the `after` of an entry written for it reads back. |
| `asOf(id, at)` | `asOf(at)` | The row's state at an instant; see [As-of and erasure](03-as-of-and-erasure.md). |
| `forget(id)` | `forget()` | Erases the row's payloads on the model's connection and the trail's own and returns how many events it redacted; see [As-of and erasure](03-as-of-and-erasure.md). |

`since` and `byActor` list the entity's `lost` markers (`op: 'lost'`, `id: '*'`, see [Inserts whose keys are not reported](01-tracking-models.md#inserts-whose-keys-are-not-reported)) beside the row entries: skip them, or pass `ops`.

`id` is the primary key value: a string, a number or a bigint (`of(9007199254740993n)` finds the row whose key is that bigint). `HistoryQuery` narrows a list:

| Field | Default | Meaning |
| --- | --- | --- |
| `limit` | 100 | 1 to 1000; anything else is refused with `HistoryConfigError`. |
| `afterSeq` | none | Only entries after this `seq`: the last `seq` of the previous page. |
| `ops` | all | Only these operations; an empty list returns nothing. |
| `from`, `to` | none | Bounds on `at`, both inclusive. |
| `changed` | none | Only entries that changed at least one of these columns; an empty list returns nothing. |

An invalid `Date` for `at`, `from` or `to`, and an `afterSeq` or a `since(seq)` cursor that is not a non-negative integer, are refused with `HistoryConfigError` as well.

- An insert or a delete lists no changed column, so `changed` never returns it; ask for it with `ops`. A redacted entry lists none either. `soft_delete` and `restore` list the soft-delete column.
- `changed` is read from the payload, which the trail cannot filter: the trail is read in pages of 1000 events, one after the other, until `limit` entries match or the list ends, so a narrow filter over a long history reads all of it. Bound such a read with `from`, `to` or `afterSeq`; this holds for `byActor` with `changed` as well.

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

## Many rows at once

`Invoice.history().latestBefore(ids, at)` returns, for each id, its last entry at or before `at` (an entry recorded exactly at `at` is included), and `latest(ids)` its last entry. "Last" is the highest `seq`, not the latest `at`: of two entries in the same millisecond the one recorded second wins, and so does an entry stamped earlier by a clock that went back. Each id the map holds is one that was asked, under the text it was asked with, and its entry is that id's own; an id without such an entry is not in the map, an id asked twice is answered once, and no ids is no read. An id no row of the model can have (`'1 '` or `'01'` for an integer key) is not in the map and costs no read. MySQL and MSSQL compare the trail's `subject_id` ignoring trailing spaces, so there the last entry the trail matches for `'a'` may be one of `'a '`: the read then takes the newest entry of `'a'` among the last 1000 the trail matches, and refuses with `HistoryConfigError` when all 1000 are another id's. That also refuses an id with no entry of its own whose look-alike has 1000 entries, and it fails the whole call: ask the other ids without it. They return row entries only, never a `lost` marker or an erasure record; the entry of a forgotten row comes back with `redacted: true`, and that of a deleted row is its `delete`, whose `before` is the row's last image.

Each id is one round trip to the trail on its `(subject_type, subject_id, seq)` index, which walks past the id's entries newer than `at` to the first one at or before it: an old instant on a busy row reads more than one index entry. `current` reads 500 keys a statement and holds every asked id and every row it found in memory. Pass ids in batches of a size you would also read rows in.

An id that is not in the map has no row entry in the trail at or before the instant; that is not "no row": the row may be older than its tracking, retention may have pruned its entries, or an insert whose keys were not reported may have written it. These reads return what the trail holds and never say whether it holds every change. A caller that takes an absent id for "did not exist", or an entry for "the state at `at`", reads the entries first and then [coverage](05-coverage.md) with `HistoryCoverage.since(trail, connection, entity)`, and trusts the answer only for an instant at or after it. `asOf(id, at)` answers `unknown` where history cannot tell.

`current(ids)` reads the rows themselves by primary key, 500 keys a statement, and returns each the way the `after` of an entry written for it reads back from the trail: the same columns (the key and the tracked columns in column mode), without excluded and masked columns, a date as ISO text, a bigint as decimal text, bytes as `{ "$bytes": "<base64>" }`, a JSON column as the driver returns it. An id matches a row by its exact text: `'01'` and `'1.0'` find no row of an integer key, and a key column that ignores case answers `'a'` only when `'a'` was asked. A row whose last entry is neither missing nor redacted therefore deep-equals the `after` of that entry unless it was written past history:

```ts sample
import { isDeepStrictEqual } from 'node:util';

import type { ModelBaseClass } from '@spinajs/orm';
import { historyOf } from '@spinajs/orm-history';

/** The ids whose row differs from what its last entry says: a write history did not see. */
export async function writtenPastHistory(model: ModelBaseClass, ids: readonly string[]): Promise<string[]> {
  const history = historyOf(model);
  const last = await history.latest(ids);
  const rows = await history.current(ids);
  return ids.filter((id) => {
    const entry = last.get(id);
    // A row without an entry (older than its tracking, or pruned) and a forgotten row say nothing about a missed write.
    return entry !== undefined && !entry.redacted && !isDeepStrictEqual(rows.get(id) ?? null, entry.after);
  });
}
```

Two more cases differ without a missed write. On sqlite and MSSQL, which hand a JSON column over as text, an update that only rewrites that text with the same value (another key order or spacing) is no change and writes no entry, so the row holds the new text and the entry the old one until the row's next recorded change. And a trail that masks, omits or hashes paths of `data.after` (`audit.trails.<name>.mask`, `omit`, `hash`) stores those values changed, while `current` returns them as the row holds them: on such a trail an image never equals an entry, and it holds what the trail hides.

`currentWhere(where, limit)` returns at most `limit` rows whose columns equal `where` now, in primary-key order, encoded the same way: `Invoice.history().currentWhere({ status: 'open' }, 100)`. A row that held the value once and no longer does is not returned. A string or a number matches a text column only as written. MySQL's and MSSQL's default collations ignore case; MSSQL, and MySQL's PAD SPACE collations such as `utf8mb4_general_ci`, also ignore trailing spaces. `currentWhere` drops the rows the database matched in another spelling and reads on in primary-key order until it has `limit` rows or reaches the last one, each page twice the last, from `limit` up to 1000 rows a statement: a value that matches many rows only in another spelling reads them all. A `char(n)` column holds its value padded with spaces to `n` on PostgreSQL and MSSQL, and history keeps it padded: ask `'ab  '`, not `'ab'`, of a `char(4)` column, as a key too. A map of exactly `limit` rows may leave more out: ask for one more than you can take to tell. A value is a string, a finite number or `null`, which matches `NULL`; a value the column's type cannot hold (text that is no number for an integer column) matches no row. Select by a text or a number column: the stored form of a date, a boolean or a JSON column differs between databases. A column history does not record (excluded, masked, or not listed in column mode) is refused with `HistoryConfigError`: its history cannot tell which rows held the value before a change.

`current` and `currentWhere` read the table without the model, as the write capture does. A soft-deleted or archived row is returned, with its soft-delete column set. No authz filter (`.accessible()`), no access guard and no `@AuditReads` record apply: a caller that hands these rows to a user checks access itself. A tenant scope does apply, by table: for a `@Tenant` model the two reads follow the rules `@spinajs/tenancy-orm` has for a statement without a model. Outside a tenant scope they are refused with `TenantRequired`; inside `runAcrossTenants(reason)` they return the rows of every tenant; inside one tenant they are refused with `NotSupported` by a tenancy version that does not filter such statements yet, and return that tenant's rows by one that does. `latestBefore` and `latest` read the trail, which no tenant scope confines, like `of` and `since`.

On a table trail all four read on the primary: the trail and the rows are read by builders without a model, which the ORM never sends to a replica. A shipping trail (`OutboxAuditStore`) is read from its archive, so `latestBefore` and `latest` see only what has been shipped. Each read is its own statement, so a write can commit between two of them; a reader that combines them reads in a fixed order and checks what it got.

A read of `of`, `since` or `byActor` returns at most 1000 entries (`limit`); a reader that follows a long span pages with `afterSeq` until a page comes back empty.

## A change feed

`since(seq)` pages through every change of a model in `seq` order. Keep the last `seq` you processed. The feed also holds the entity's `lost` markers, whose `id` is `'*'`, not a row:

```ts sample
import { historyOf } from '@spinajs/orm-history';
import type { ModelBase } from '@spinajs/orm';
import type { Constructor } from '@spinajs/di';

export async function follow(model: Constructor<ModelBase>, after: number, handle: (op: string, id: string) => Promise<void>): Promise<number> {
  const entries = await historyOf(model).since(after, { limit: 500 });
  for (const e of entries) if (e.op !== 'lost') await handle(e.op, e.id);
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
