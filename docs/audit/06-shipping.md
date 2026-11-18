# Shipping

A shipping trail does not keep its events in the application database. It buffers them in a table there, and a shipper moves them to a destination: an archive table on another ORM connection, or a message broker that feeds a dedicated audit service. Ship when the application database should stay small, when several applications write to one central audit store, or when the trail must end up somewhere the application cannot rewrite.

## How it works

1. A trail with `store: 'OutboxAuditStore'` writes its events into `audit_outbox`, with the trail's name, in every write mode. A transactional event goes into the audited write's transaction on its connection; a confirmed or deferred one goes to the connection the write names, else the trail's `connection`. A confirmed write inside a transaction behaves as for a table trail ([Trails and guarantees](01-trails-and-guarantees.md#a-confirmed-write-inside-a-transaction)).
2. `shipAudit()` looks for `audit_outbox` on every distinct ORM connection. Per shipping trail and connection it reads the oldest `audit.ship.batchSize` rows by `seq`, hands them to the trail's `sink` as `{ trail, source, events }`, and deletes them after `deliver` returned. `source` is the driver name of the connection that buffered them (never an alias such as `default`).
3. The sink stores the batch: `ArchiveAuditSink` in the trail's `table` on `archiveConnection`, `QueueAuditSink` as messages on a broker.

**Delivery is at least once.** A crash between delivery and delete, or a delivery abandoned at its deadline that lands later, delivers the same events again; every sink deduplicates on the event `id`. Events of one trail are shipped in `seq` order among the rows the shipper can see, not in commit order, and events of different connections are shipped independently.

## Setup: an archive on another connection

```json
{
  "audit": {
    "trails": {
      "shipped": { "store": "OutboxAuditStore", "sink": "ArchiveAuditSink", "reader": "ArchiveAuditReader", "archiveConnection": "audit" }
    }
  }
}
```

The application declares the tables; the package binds none of these migrations to a connection:

```ts sample
import { AuditArchiveTableMigration, AuditOutboxTableMigration } from '@spinajs/audit-orm';
import { Migration } from '@spinajs/orm';

// On every connection that buffers: the trail's connection and each connection of a transactional write.
@Migration('default')
export class AuditOutbox_2026_11_17_00_00_00 extends AuditOutboxTableMigration {}

@Migration('audit')
export class AuditShipped_2026_11_17_00_00_01 extends AuditArchiveTableMigration {
  protected override table(): string {
    return 'audit_shipped';
  }
}
```

The archive table is the trail's `table` plus a `source` column (64 characters) and a unique index on `id`; `seq` there is the arrival order. One archive table per trail: the table-per-trail rule of [Trails and guarantees](01-trails-and-guarantees.md#tables) holds for archives too. A shipping trail without `table` archives into `audit_<trail>` (`audit_shipped` above); `AuditArchiveTableMigration` creates `audit_event` unless `table()` is overridden, so override it as above. A shipping trail without an archive in this application (`archiveConnection` unset: shipped through a queue or a custom sink) claims no table.

## The shipping task

Import `@spinajs/audit-orm/scheduler` and `AuditShipTask` runs `shipAudit()` every 10 seconds on the scheduler leader (schedule `audit.ship`, overlap `skip`, timeout 10 minutes). Turn it off with `scheduler.schedules['audit.ship'].enabled: false` and call `shipAudit()` yourself, or run it from any other job:

```ts sample
import { auditBacklog, shipAudit } from '@spinajs/audit-orm';

export async function shipNow() {
  const { shipped, failed, stoppedEarly } = await shipAudit({ trail: 'shipped' });
  const backlog = await auditBacklog();
  return { shipped, failed, stoppedEarly, behind: backlog.filter((b) => b.pending === null || b.pending > 0) };
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `audit.ship.batchSize` | 200 | Events per delivery, 1 to 500. |
| `audit.ship.maxBatches` | 50 | Deliveries per trail and connection in one run. |
| `audit.ship.deliverTimeoutMs` | 30000 | At most 120000. A delivery still pending then fails and its events stay buffered; a late success is a duplicate. |
| `audit.ship.runBudgetMs` | 300000 | No batch starts after it. |

`runBudgetMs` plus `deliverTimeoutMs` must stay under the schedule's 10-minute timeout, or the run is refused with `AuditConfigError`. A run the budget stops logs what it left buffered and returns `stoppedEarly: true`; the next full run starts at the trail and connection the budget stopped before it shipped anything, or after the one it interrupted, so one slow trail cannot take every run. A run narrowed by `trail` or `connection` leaves that rotation alone.

**When a delivery fails**, that trail's events stay buffered on that connection and `failed` names `{ trail, connection }`; the other trails and connections go on. A connection that cannot be searched fails every trail on it. The task then throws, so the scheduler records a failed run, and `pauseAfterFailures` on `audit.ship` pauses shipping for every trail. There is no dead-letter: an event a sink always refuses blocks its trail on that connection until someone removes or fixes it.

**Lag.** `auditBacklog()` returns per trail and connection `pending` and `oldestAt`, or `pending: null` and `error` for a connection that cannot be read. Alert on a growing `pending`, on `oldestAt` older than a few shipping intervals, and on failed `audit.ship` runs.

## Reading an archive

`ArchiveAuditReader` reads the archive table on `archiveConnection`. `source` selects the connection the events were buffered on; without one it is the trail's `connection`, resolved to its driver name. Reads are eventually consistent: an event is visible after it was shipped. Order an archive by time (`ArchiveAuditReader.list(trail, filter, 'at')`) when its events came over a queue: `seq` there is arrival order, which competing consumers, an SQS standard queue or a redelivered message do not keep.

Retention of a trail with an archive prunes the archive once, for every source; `forget` is described in [Erasure](08-erasure.md). Call `forget` on a shipping trail outside a transaction.

## Setup: shipping through a queue to an audit service

`@spinajs/audit-orm/queue` uses `@spinajs/queue`, an optional peer: install it and import the subpath in both applications.

The shipping application names `sink: 'QueueAuditSink'` and routes `AuditBatchRecorded` to a real connection:

```json
{
  "audit": { "trails": { "remote": { "store": "OutboxAuditStore", "sink": "QueueAuditSink" } }, "queue": { "maxMessageBytes": 200000 } },
  "queue": { "routing": { "AuditBatchRecorded": { "connection": "audit-broker" } } }
}
```

Each batch is published as persistent `AuditBatchRecorded` messages, split so that none exceeds `audit.queue.maxMessageBytes` (default 200000, at least 1024; keep it under the broker's own limit). An event too large for a message alone fails the delivery before anything is published. A route to the black-hole connection, the shipped default, is refused. The sink returns when the transport's `emit` returns: the AMQP transport waits for the publisher confirm, the SQS transport for the `SendMessage` response. On a transport that does not confirm, delivery is at most once from the broker on. On AMQP an event goes to a topic: bind the receiving service's durable subscription before shipping starts, or the broker drops what nobody listens to.

The receiving service configures a trail of the same name with an archive, declares the archive and outbox migrations (its own events, such as the `erasure` record of `forget`, are buffered and archived beside the shipped ones) and subscribes once at startup:

```ts sample
import { consumeAuditBatches } from '@spinajs/audit-orm/queue';

// audit.trails.remote = { store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', archiveConnection: 'audit', table: 'audit_remote' }
export async function startAuditService(): Promise<void> {
  await consumeAuditBatches();
}
```

`consumeAuditBatches(subscriptionId?)` subscribes durably (`audit-archive` by default) and stores each batch through `ArchiveAuditSink`. A redelivered or duplicated message stores each event once. After storing a batch it blanks the arriving events of subjects erased at or after them; it looks for pending erasures in the archive and in the service's `audit_outbox` on the trail's own connection only, so after `forget(subject, source)` in the receiving service, with one of its own connections other than the trail's as `source`, the window lasts until its next shipping run ([Erasure](08-erasure.md#a-trail-shipped-through-a-queue)).

**Trust boundary.** Without [signed batches](#signed-batches) the consumer stores every well-formed `AuditBatchRecorded` message as genuine audit events, with the publisher's `id`, `source`, `actor` and `at`. Whoever can publish to the route can add, backdate or misfile events in the archive, and a seal proves integrity only from archiving on. Make the route writable by the shipping applications only; broker permissions stay the first line with signing too.

**Refused messages.** A message is refused whole when an event is not what the sink writes: `at` must be the `toISOString()` text, every string field must fit its column, an optional field is a string or absent, `kind` and `outcome` must be known. The error names the first refused event and field (`audit: malformed AuditBatchRecorded message: event <id>: <field> ...`). A refused message, a batch of a trail the service does not configure, or a `Source` over 64 characters fails on every delivery: SQS redelivers it until its redrive policy moves it to a dead-letter queue, so configure one for `AuditBatchRecorded`; AMQP and STOMP drop a failed event after one warning line. When a release adds an event kind or outcome, upgrade the receiving service before the shipping applications.

**Clocks.** An event whose `at` is more than 5 minutes ahead of the receiving service's clock is refused until that clock catches up: it is delayed, or moved to the dead-letter queue past the queue's maximum receive count. Keep the clocks of every application that shares an archive synchronized; erasure on arrival depends on them too ([Erasure](08-erasure.md#a-trail-shipped-through-a-queue)).

**Sources across applications.** The archive files events under the shipping application's driver name. The receiving service maps `default` and its trail's `connection` to its own driver names, so its reads without a `source` find none of the shipped events: pass `source`, the shipping connection's name, to `of`, `byActor`, `since` and the other reads. Retention and `forget` without a `source` cover every source of the archive, so applications that share an archive use subject keys unique among them.

### Signed batches

Signing is off by default. A shipping application signs every message with one key; the receiving service lists, per `source`, the keys it accepts:

```json
{ "audit": { "queue": { "signing": { "keyId": "billing-2026", "secret": "<at least 16 characters, from the environment>" } } } }
```

```json
{ "audit": { "queue": { "verify": { "required": true, "keys": { "billing-app": [{ "id": "billing-2026", "secret": "<the same secret>" }] } } } } }
```

A signed message carries `KeyId` and `Sig`, the base64url HMAC-SHA256 of the canonical JSON (`canonicalJson` of `@spinajs/audit`) of `{ trail, source, events }`, the events as they travel (`at` as `toISOString()` text). A message without signing has the same fields as before. The consumer checks the signature before it reads an event, by the key the message names among the keys of its `Source`, in constant time. It refuses a message whose source has no keys, whose key id is not listed for its source, whose `KeyId` or `Sig` is missing or not a string, or whose signature does not match, and with `required: true` also an unsigned one. Without `required` an unsigned message is accepted, so producers can be switched on one by one; a signed one is checked all the same. Without `audit.queue.verify` nothing is checked.

A refused message stores nothing. The consumer logs one error line on `audit-queue` (`audit: refused AuditBatchRecorded of trail ... from source ...: <reason>`, with `trail`, `source`, `keyId` and `reason`) and fails it with a `PermanentJobFailure` (reason `audit_signature`). The transport handles the failed event as it handles any: AMQP and STOMP drop it, SQS redelivers it until its redrive policy moves it to the dead-letter queue, and each redelivery is refused and logged again. Set `required: true` only after every producer of the trail signs: a genuine batch refused on AMQP or STOMP is lost, and its producer counts it as shipped.

Rotation: list the new key beside the old one in the receiving service, then switch the producer's `signing` to it, then remove the old key once nothing signed with it is in flight. Keys are per source: a stolen producer key forges events of that source, and a compromised producer signs whatever it likes for its own source. The damage does not stay in that source: an `erasure` record (`kind: 'custom'`, `action: 'erasure'`) signed with it blanks the payloads of its subject's events in every source, archived and arriving, with `at` at or before its own, and `verify` counts them as explained redactions, not as `unexplainedRedactions`. A replayed message is harmless while its events are retained, since events are deduplicated by `id`; replayed after retention pruned them, it stores them again with their payloads.

## Limits

- At least once: a destination sees duplicates unless it deduplicates on `id`.
- Reads of a shipping trail lag by up to one shipping interval, longer while a delivery fails.
- No dead-letter in the shipper: one event a sink always refuses blocks its trail on that connection.
- Events of one trail on several connections, or from several applications, are not one ordered stream.
