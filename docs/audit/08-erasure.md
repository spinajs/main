# Erasure

`audit().trail(name).forget(subject, source?)` erases the payload of every event about one subject, erasure records excepted, for a data subject's right to erasure, and records that it did.

```ts sample
import { audit } from '@spinajs/audit';

export async function eraseCustomer(id: string): Promise<number> {
  return audit().trail('billing').forget({ type: 'customer', id });
}
```

## What is blanked and what is kept

- **Blanked:** `data`. It is stored as an empty string and reads back as `{}` with `redacted: true`.
- **Kept:** every other field (`id`, `at`, `kind`, `action`, `subject`, `actor`, ...) and `data_hash`, the hash of the payload that was there. So who did what to the subject and when stays on record, and a seal over the event still verifies ([Integrity and verification](07-integrity-and-verification.md)).
- **Never blanked:** the subject's earlier erasure records, the events with `kind: 'custom'` and `action: 'erasure'`. They are the evidence of earlier erasures, so forgetting a subject again keeps their payload and count. That pair is reserved for `forget`: an event a producer records with it is never blanked either, so record your own events under another action. An event of another kind whose action is `erasure` is blanked like any other.
- **Returned:** how many events this call blanked; events already blank are not counted again.

Then `forget` records an `erasure` event (`kind: 'custom'`, `action: 'erasure'`, the subject, `data: { redacted: <count> }`) in the confirmed mode beside the events it redacted: on `source` when one is given (on a shipping trail whose `source` is no connection of this application, on the trail's `connection`); without one on the trail's `connection`, and, on a table trail, on each other connection where the subject has a row, with that connection's count. `verify` looks for the record in the same table on the same connection. A failure to record one leaves that connection's payloads blanked without their record, which `verify` reads as SUSPECT: on a `reject` trail `forget` throws `AuditWriteFailed`; on a `continue` trail the failure is logged and `forget` resolves. Run `forget` again to repair it: it writes the record on every connection where the subject has a row, also when nothing is left to blank.

`subject` and `dataSubject` are not touched, so a subject key must not itself be personal data you have to erase.

## Which connections

| Trail | `forget(subject)` | `forget(subject, source)` |
| --- | --- | --- |
| Table trail | The table on every connection that holds it (with the columns `seq`, `at` and `data_hash`), the trail's `connection` included. | The table on `source`. |
| Shipping trail with a reader | The buffer on every connection that holds `audit_outbox`, and the destination for every source. | The buffer on `source` when it is a connection of this application, and the destination's events of that source. |
| Shipping trail without a reader, `LogAuditStore` | Refused with `AuditNotSupported`; nothing is touched. | The same. |

A table trail written transactionally keeps events on the connection of each audited write, so `forget(subject)` looks for the trail table on every ORM connection before it blanks anything; a connection that cannot be looked at fails the call with nothing erased. It then blanks one connection at a time and records that connection's `erasure` event before it goes on, so a failure on one connection leaves those before it blanked and recorded, and the rest untouched. Pass `source` to erase on one connection. Because it looks at every connection, `forget(subject)` waits for a connection that shares one PGlite instance with an open transaction, and can wait forever when it is called inside that transaction.

## Shipping trails

Call `forget` on a shipping trail outside a transaction. Inside one, the buffer of the transaction's connection is blanked in that transaction while the destination is redacted at once: a rollback restores the buffered payloads, which are then shipped, and on sqlite and PGlite also drops the `erasure` event. The destination then stays blanked without its record, which `verify` reads as SUSPECT, until `forget` runs again. Without a `source`, `forget` reads every connection that buffers, so it waits for a connection that shares one PGlite instance with an open transaction, as on a table trail.

An event erased while it is still buffered is shipped with an empty payload. An event whose delivery was under way when `forget` ran may reach the destination with its payload after the destination was redacted. The shipper catches both: rows it delivered that were blanked meanwhile stay buffered until it has redacted their subjects at the destination again, and a failed redaction is retried on the next run. The window is one delivery: from a late landing to the shipping run that handles those rows again.

## A trail shipped through a queue

A shipping application usually has no reader for a queue-shipped trail, so `forget` is refused there: issue it in the receiving service. There `forget(subject)` redacts the archive for every source and blanks the service's own buffers; `forget(subject, source)`, with the name of a shipping application's connection as the archive files it, redacts that application's events only. Events still buffered in a shipping application or in flight in the broker arrive later with their payload. The consumer blanks them on arrival, after storing a batch, and keeps their `data_hash`:

- An arriving event is blanked when its subject has an `erasure` event at or after the event's `at`, in the archive or still in the receiving service's own `audit_outbox` on the trail's connection. Newer events of the subject and erasure records keep their payload. The match ignores `source`: after `forget(subject, source)` an arriving event of that subject from another application, recorded before the erasure, is blanked too.
- An arriving `erasure` event, which a shipping application with a reader records after redacting the archive, blanks the archived events of its subject with `at` at or before its own, in every source, erasure records excepted: events in flight when it ran reach the archive before it.

What this does not cover:

- **Clocks.** The boundary is the `at` of the recording applications' clocks. An event recorded just before an erasure on a clock that runs ahead keeps its payload; one recorded just after it on a clock that runs behind is blanked. Keep the clocks of every application that shares an archive synchronized; the 5-minute rule of the consumer does not bound this.
- **`forget(subject, source)` with a connection of the receiving service.** A `source` that names a shipping application's connection buffers the `erasure` record on the trail's connection, where the consumer looks for pending erasures. Because such a name could also be a mistyped connection, an application with an `audit_outbox` on any connection (a receiving service included) logs a warning on `audit-ship` that names the `source`; nothing is refused. A `source` that names one of the receiving service's own connections, other than the trail's, buffers it there, and the consumer's look-up reads only the trail's own connection: the window lasts until the receiving service's next shipping run.
- **An erasure in a shipping application without a reader:** refused there. Issue it in the receiving service.

Applications that share an archive share subject keys: `forget(subject)` in the receiving service erases that key for every shipping application; pass `source` to erase it for one.

## Erased events in reads and in `verify`

A read returns an erased event with `redacted: true` and `data: {}`. `verify` counts it as `redacted`; it lists the event in `unexplainedRedactions` (and `spinajs audit:verify` reports SUSPECT) when no `erasure` event of its subject at or after it is in the table where verification can vouch for it: inside a seal that verified, or in the unsealed tail while the record is younger than the sealing window ([Erasure records](07-integrity-and-verification.md#erasure-records)). In a receiving service an event blanked on arrival because of an erasure still in its own buffer is reported that way until the erasure is shipped into the archive, about one shipping interval.

## Limits

- A payload blanked by hand with its `data_hash` kept looks exactly like a lawful erasure; only the `erasure` event tells them apart. A forged `erasure` record that got sealed proves nothing against someone who can write the trail table: the chain is keyless, so ship the sealer's head hash out of the database and pin it.
- `forget` erases payloads, not the fields that identify the event, and not copies outside the trail (logs, backups, a broker's dead-letter queue).
