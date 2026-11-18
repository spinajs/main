# Erasure

`audit().trail(name).forget(subject, source?)` erases the payload of every event about one subject, for a data subject's right to erasure, and records that it did.

```ts sample
import { audit } from '@spinajs/audit';

export async function eraseCustomer(id: string): Promise<number> {
  return audit().trail('billing').forget({ type: 'customer', id });
}
```

## What is blanked and what is kept

- **Blanked:** `data`. It is stored as an empty string and reads back as `{}` with `redacted: true`.
- **Kept:** every other field (`id`, `at`, `kind`, `action`, `subject`, `actor`, ...) and `data_hash`, the hash of the payload that was there. So who did what to the subject and when stays on record, and a seal over the event still verifies ([Integrity and verification](07-integrity-and-verification.md)).
- **Returned:** how many events this call blanked; events already blank are not counted again.

Then `forget` records an `erasure` event (`kind: 'custom'`, `action: 'erasure'`, the subject, `data: { redacted: <count> }`) in the confirmed mode, on `source` when one is given and on the trail's `connection` otherwise, so it lies beside the events it redacted. On a `reject` trail a failure to record it throws `AuditWriteFailed` after the payloads were blanked.

`subject` and `dataSubject` are not touched, so a subject key must not itself be personal data you have to erase.

## Which connections

| Trail | `forget(subject)` | `forget(subject, source)` |
| --- | --- | --- |
| Table trail | The table on the trail's `connection` only. | The table on `source`. |
| Shipping trail with a reader | The buffer on every connection that holds `audit_outbox`, and the destination for every source. | The buffer on `source`, and the destination's events of that source. |
| Shipping trail without a reader, `LogAuditStore` | Refused with `AuditNotSupported`; nothing is touched. | The same. |

A table trail written transactionally on several connections needs one `forget` per connection, with its `source`.

## Shipping trails

Call `forget` on a shipping trail outside a transaction. Inside one, the buffer of the transaction's connection is blanked in that transaction while the destination is redacted at once: a rollback restores the buffered payloads, which are then shipped, and on sqlite and PGlite also drops the `erasure` event. Without a `source`, `forget` reads every connection that buffers, so it waits for a connection that shares one PGlite instance with an open transaction.

An event erased while it is still buffered is shipped with an empty payload. An event whose delivery was under way when `forget` ran may reach the destination with its payload after the destination was redacted. The shipper catches both: rows it delivered that were blanked meanwhile stay buffered until it has redacted their subjects at the destination again, and a failed redaction is retried on the next run. The window is one delivery: from a late landing to the shipping run that handles those rows again.

## A trail shipped through a queue

A shipping application usually has no reader for a queue-shipped trail, so `forget` is refused there: issue it in the receiving service. There `forget(subject)` redacts the archive for every source and blanks the service's own buffers. Events still buffered in a shipping application or in flight in the broker arrive later with their payload. The consumer blanks them on arrival, after storing a batch, and keeps their `data_hash`:

- An arriving event is blanked when its subject has an `erasure` event at or after the event's `at`, in the archive or still in the receiving service's own `audit_outbox` on the trail's connection. Newer events of the subject and erasure records keep their payload.
- An arriving `erasure` event, which a shipping application with a reader records after redacting the archive, blanks the archived events of its subject with `at` at or before its own, in every source, erasure records excepted: events in flight when it ran reach the archive before it.

What this does not cover:

- **Clocks.** The boundary is the `at` of the recording applications' clocks. An event recorded just before an erasure on a clock that runs ahead keeps its payload; one recorded just after it on a clock that runs behind is blanked. Keep the clocks of every application that shares an archive synchronized; the 5-minute rule of the consumer does not bound this.
- **`forget(subject, source)` in the receiving service.** It buffers its `erasure` record on `source`, and the consumer's look-up of pending erasures reads only the trail's own connection: the window lasts until the receiving service's next shipping run. `source` must name a connection of the receiving service; the name of a shipping application's connection is refused with `AuditConfigError`, so use `forget(subject)` there.
- **An erasure in a shipping application without a reader:** refused there. Issue it in the receiving service.

Applications that share an archive share subject keys: `forget(subject)` in the receiving service erases that key for every shipping application.

## Erased events in reads and in `verify`

A read returns an erased event with `redacted: true` and `data: {}`. `verify` counts it as `redacted`; it lists the event in `unexplainedRedactions` (and `spinajs audit:verify` reports SUSPECT) when no `erasure` event of its subject at or after it is in the table. In a receiving service an event blanked on arrival because of an erasure still in its own buffer is reported that way until the erasure is shipped into the archive, about one shipping interval.

## Limits

- A payload blanked by hand with its `data_hash` kept looks exactly like a lawful erasure; only the `erasure` event tells them apart.
- `forget` erases payloads, not the fields that identify the event, and not copies outside the trail (logs, backups, a broker's dead-letter queue).
