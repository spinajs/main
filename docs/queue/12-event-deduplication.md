# Event deduplication

Brokers deliver at least once: a consumer that dies before its ack, a broker failover or the [outbox](10-outbox.md) relay can hand the same event to a subscription twice. With `queue.deduplicateEvents` on, a named subscription runs its handler once per `MessageId`, and a repeat is acked without running it. Off by default in 4.x.

Handling stays **at least once, with duplicates suppressed** ([The guarantee](#the-guarantee)). Jobs are not affected: they keep their own deduplication by `JobId` (`queue.deduplicate`, see [Job tracking](03-job-tracking.md)).

## Turning it on

| Key | Default | Meaning |
| --- | --- | --- |
| `queue.deduplicateEvents` | `false` | Deduplicate events delivered to a subscription with a `subscriptionId` |
| `queue.deduplicateTtl` | `'7d'` | How long a handled `MessageId` is remembered: a whole number of milliseconds above 0, or a string with a unit and an amount above zero (`'36h'`, `'7d'`). Anything else (`0`, `'0s'`, `null`, a boolean, `''`) fails the boot |
| `queue.deduplicate` | `true` | `false` turns job and event deduplication off together |

Deduplication runs on `@spinajs/idempotency`, an optional peer of `@spinajs/queue`. Install it, import it in the app entry before the boot, so its model and the `__idempotency` migration are registered before the Orm resolves, and map its connection with `db.Aliases.idempotency` (default `default`):

```ts sample
import '@spinajs/idempotency';
import { Event, QueueEvent, QueueService } from '@spinajs/queue';
import { DI } from '@spinajs/di';

// config/queue.ts
export const config = {
  db: { Aliases: { idempotency: 'default' } },
  queue: { deduplicateEvents: true, deduplicateTtl: '7d' },
};

@Event()
export class PaymentCaptured extends QueueEvent {
  public PaymentId: string;
}

export async function startLedger(book: (paymentId: string) => Promise<void>) {
  const queue = await DI.resolve(QueueService);
  // 'ledger' names the subscription: deduplication is per subscriptionId
  await queue.consume<PaymentCaptured>(PaymentCaptured, (m) => book(m.PaymentId), 'ledger');
}
```

`consume()` checks the setup when the subscription is made, not at the first delivery. It throws `InvalidOperation` when `@spinajs/idempotency` is not installed, when the Orm resolved before it was imported, and when a connection of the event cannot redeliver (below). An invalid `idempotency.*` value throws `InvalidConfiguration` there too. A `deduplicateTtl` of zero is refused at boot with `InvalidConfiguration` by the queue's configuration schema; a process that runs no Bootstrappers gets `InvalidArgument` from `consume()` instead.

## Why a `subscriptionId` is required

The record of a handled event is kept per subscription: namespace `queue:<subscriptionId>`, key `MessageId`, in `__idempotency`. Two subscriptions of one event (a ledger and a mailer) each handle it once. A subscription without a `subscriptionId` has no stable name across restarts and replicas, so it is never deduplicated; neither is an event that arrives without a `MessageId`.

What one subscription is depends on the transport:

| Transport | One subscription |
| --- | --- |
| AMQP | One queue per `subscriptionId` |
| STOMP | One durable subscription per replica; the copies the replicas receive collapse into one handling under one `subscriptionId` |
| SQS | One queue |

## What each delivery does

- **First delivery.** The consumer claims the key, runs the handler, and stores the reply. `queue.before-ack` runs, then the transport acks.
- **Repeat after success.** The key holds a stored reply: the delivery is acked without running the handler, for `deduplicateTtl` after the first one.
- **Handler failure.** The key is released and the error goes to the transport, which retries as it would without deduplication. The retry runs the handler again.
- **In-flight duplicate.** A copy that arrives while another consumer holds the key, and keeps its lease, throws `RedeliverLater` (from `@spinajs/queue`, with `delayMs`, the time left on the holder's lease). It is never acked and never run beside the first copy while that copy's holder keeps renewing its lease: the transport redelivers it, and by then it is either a repeat after success or, if the first copy failed, a first delivery. `isRedeliverLater(error)` tells it apart from a handler error, also across copies of the package. An `IdempotencyInFlight` the handler itself throws (from an idempotent call of its own) is a handler failure, not a `RedeliverLater`.
- **The claim fails** (the database is unreachable). The delivery fails without running the handler, and the transport redelivers it: the queue throws `RedeliverLater` with `CLAIM_FAILURE_REDELIVERY_MS` (1000 ms). It is not counted as a retry and repeats while the store is down. On SQS in `redrive` mode the redelivery comes after the visibility timeout instead of 1000 ms, each one counts toward `maxReceiveCount`, and past it the event goes to the queue's redrive dead-letter queue.
- **Storing the reply fails.** The handler's work is done, so the delivery is still acked; the failure is logged on the `idempotency` logger and the key is released. A later duplicate runs the handler again.
- **`queue.before-ack` throws.** It runs after the reply is stored, so the delivery fails, the transport redelivers it, and the redelivery is acked as a repeat. Without deduplication the redelivery runs the handler again.

### Transports

A connection that acks a failed event instead of redelivering it would drop an in-flight duplicate. `QueueClient.RedeliversFailedEvents` says which kind a connection is, and `consume()` refuses `deduplicateEvents` on one that answers `false`:

| Transport | Event deduplication |
| --- | --- |
| `MemoryQueueClient` (`@spinajs/queue/testing`) | With `options.deferred: true`; refused otherwise |
| `SqsQueueClient` | Yes: a failed or in-flight event comes back after the visibility timeout. Each redelivery counts toward the queue's `maxReceiveCount`, so keep it at 5 or more for a deduplicated subscription |
| `AmqpQueueClient`, `StompQueueClient` | Refused in this release |

The delivery-contract release changes this for two transports: AMQP accepts event deduplication, and STOMP accepts it on a connection with `options.virtualTopics`. A STOMP connection without virtual topics keeps refusing it.

## The guarantee

Handling is at least once, with duplicates suppressed:

- A delivery whose `MessageId` already has a stored reply in this subscription is acked without running the handler, for `deduplicateTtl`.
- A delivery that arrives while another copy holds the key is redelivered, never acked and never run concurrently, as long as the holder keeps its lease (`idempotency.lease`, renewed while the handler runs).
- The handler runs a second time in exactly these cases: the consumer dies (or loses its lease for longer than `idempotency.lease`) after the handler's own work is committed and before the reply is stored; the duplicate arrives after `deduplicateTtl`; storing the reply fails.

A handler whose effect must not repeat keys its own write on `MessageId`, for example a unique column, in the same transaction as the effect.

## Housekeeping

Every handled event leaves one row in `__idempotency` for `deduplicateTtl`. Nothing in `@spinajs/idempotency` deletes expired rows on its own: the sweep is `@spinajs/idempotency-scheduler`, a separate package. Without it, call `IdempotencyService.sweep()` on a schedule of your own.

Size the table as events per day × deduplicated subscriptions × `deduplicateTtl` in days: 50 000 events a day to 2 subscriptions with the default 7 days keep about 700 000 rows.

## Related

- [Transactional outbox](10-outbox.md): publishes at least once, so its consumers see duplicates this page suppresses.
- [Message ids and headers](13-message-ids-and-headers.md): where `MessageId` comes from.
- [`@spinajs/idempotency`](../idempotency/README.md): the store, `idempotency.lease`, and `sweep()`.
