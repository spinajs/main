# Reading the trail

`audit().trail(name?)` returns the `AuditTrail` of one trail (`default` without a name). Reads go to the reader of the trail's store.

| Method | Returns |
| --- | --- |
| `byActor(actor, query?)` | Events whose `actor` is that principal key. |
| `of(subject, query?)` | Events about one `{ type, id }`. |
| `byTrace(traceId, query?)` | Events of one request; the id must be 32 lowercase hex digits. |
| `since(seq, query?)` | Events after a `seq`, for a consumer that pages through the trail. |
| `forget(subject, source?)` | See [Erasure](08-erasure.md). |
| `verify(source?, pinned?)` | See [Integrity and verification](07-integrity-and-verification.md). |

`AuditQuery` narrows a read:

| Field | Default | Meaning |
| --- | --- | --- |
| `limit` | 100 | 1 to 1000; anything else is refused with `AuditConfigError`. |
| `order` | `asc` | By `seq`. |
| `afterSeq` | none | Only events after this `seq`. |
| `kinds`, `actions` | all | Only these kinds or actions; an empty list returns nothing. |
| `subjectType` | all | Only events about subjects of this type. |
| `from`, `to` | none | Bounds on `at`, both inclusive. |
| `source` | the trail's `connection` | The connection whose events are read. |

```ts sample
import { audit } from '@spinajs/audit';

export async function invoiceHistory(id: string) {
  return audit().trail().of({ type: 'invoice', id }, { kinds: ['data'], order: 'desc', limit: 20 });
}

export async function page(after: number) {
  const events = await audit().trail().since(after, { limit: 500 });
  return { events, next: events.length > 0 ? events[events.length - 1].seq : after };
}
```

## What comes back

A read returns `StoredAuditEvent`s: the `AuditEvent` plus `seq`, its position in the table it was read from, and `redacted`, true when an erasure blanked its payload (`data` is then `{}`). The payload is stored as canonical JSON, so its keys come back sorted, whatever order the producer wrote them in. `at` comes back as a `Date` with millisecond precision on every dialect.

## Events on several connections

A transactional event is written on the connection of the audited write, a confirmed or deferred one on the trail's `connection` (or the `connection` the write named). One trail can therefore have a table on several connections, each with its own `seq`. A read covers one of them: `query.source`, else the trail's connection. Pass `source` to read the events written transactionally on another connection; `seq` and `afterSeq` are positions on that connection only.

For a shipping trail, `source` selects the connection whose buffer held the event; see [Shipping](06-shipping.md#reading-an-archive).

## `Model.audit()`, `row.audit()` and `auditOf()`

`@spinajs/audit-orm` reads what was recorded about a model and a row: `auditOf(Model, trail?)` and `auditOf(row, trail?)`
for any model, and `Model.audit(trail?)` and `row.audit(trail?)` on a model marked `@Auditable()`, which declares their
typing with an interface merged with the class and a `declare static` line. The subject type is the model's table name and the subject id the primary key: a string as it is, a number or bigint in decimal, a `Buffer` or typed array as lowercase hex, a composite key as its parts joined with `:` (`%` and `:` in a part escaped as `%25` and `%3A`). A producer that records events about rows names them with `auditSubjectType(model)` and `auditSubjectId(key)` so these reads find them, passing the key as the loaded model holds it (after its converters), not the raw column value: a binary key with a converter gives hex from the raw column but the converted text from the model.

```ts sample
import { Auditable, auditOf } from '@spinajs/audit-orm';
import type { AuditableModel, AuditableRow } from '@spinajs/audit-orm';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

export interface Invoice extends AuditableRow {}

@Connection('default')
@Model('invoice')
@Auditable()
export class Invoice extends ModelBase<Invoice> {
  declare static audit: AuditableModel['audit'];

  @Primary()
  public Id: number;
}

@Connection('default')
@Model('customer')
export class Customer extends ModelBase<Customer> {
  @Primary()
  public Id: number;
}

export async function audited(invoice: Invoice) {
  const ofRow = await invoice.audit().entries({ limit: 50 });
  const ofOne = await Invoice.audit('billing').of(42);
  const changedSince = await auditOf(Customer).since(1000, { source: 'default' }); // a model without the mark
  return { ofRow, ofOne, changedSince };
}
```

`Model.audit(trail?)`, `row.audit(trail?)` and `auditOf` read the `default` trail unless named. When the model's connection is not the trail's, both are read and merged by `at`: transactional events sit on the model's connection, the others on the trail's. Such a merged read refuses `afterSeq` (a position on one connection); pass `source` to page one of them. A connection that cannot be reached fails a merged read instead of returning part of it. `row.audit()` on a row without a primary key value is refused.

## `AuditNotSupported`

Thrown when the trail cannot answer from this application: its store has no reader (`LogAuditStore`, a shipping trail without `reader`), or, for `verify`, the trail is not sealed or its reader cannot verify.

## Limits

- Reads apply no authorization scoping. Whoever may call `audit().trail()`, `Model.audit()`, `row.audit()` or `auditOf()` reads every event of the trail: the application decides who may.
- Events of one trail on several connections are not one ordered stream; `seq` orders one connection only.
- A read of a shipping trail sees an event once it was shipped: events still in the buffer are not merged in.
