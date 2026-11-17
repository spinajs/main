# Delivery contract

When a handler fails, a transport must choose between retrying the message, moving it to a dead-letter channel and dropping it. `decideDelivery()` makes that choice. It is one pure function, so every transport that executes it behaves the same way and can be tested against the same cases. The transport then carries out the answer with its own broker primitive: a delayed queue, a scheduled republish or a visibility change.

The policy comes from `queue.routing` and from the connection, through `resolveDeliveryPolicy()`. Each transport's docs say whether it executes the decision yet.

## The decision

`decideDelivery(message, attempt, error, policy)` checks these rules in order. `attempt` is the received copy's `x-retry-count`, which is 0 on the first delivery.

| # | Condition | Decision |
| --- | --- | --- |
| 1 | the error has `crash: true` | throws `InvalidArgument`: a crash is never decided |
| 2 | `isRedeliverLater(error)` | `retry`, `attempt` unchanged, `delayMs` from the error, `forced: true` |
| 3 | `UnparseableMessageError` (the body could not be parsed) | `dead-letter`, `reason: 'unparseable'` |
| 4 | an event, and `onEventFailure` is `'drop'` (the default) | `ack`, `dropped: true` |
| 5 | `PermanentJobFailure`, or an error named `NonRetryableError` | `dead-letter`, `reason: 'non-retryable'` |
| 6 | `attempt < maxRetries` | `retry` with `attempt + 1`, after `backoffDelay(backoff, attempt + 1)` |
| 7 | otherwise | `dead-letter`, `reason: 'exhausted'` |

Every `retry` and `dead-letter` decision carries these headers. The transport adds `x-original-destination`, because the decision does not know the channel.

| Header | Value |
| --- | --- |
| `x-error` | the error's message, or its name when the message is empty, cut at 1024 characters (`DELIVERY_ERROR_MAX_LENGTH`); for an unparseable body it starts with `unparseable message body:` |
| `x-spinajs-message-id` | the message's `MessageId`, when it has one |
| `x-retry-count` | the next attempt for a retry, the last attempt for a dead letter; absent for an unparseable body |

`retryCountOf(headers)` reads `x-retry-count` as a string or as a number, because the AMQP transport of 3.x writes a number and its retry copies may still be in a broker after an upgrade.

## Routing options

| Key | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | `0` | Retries before a dead letter. A job's own `RetryCount` wins |
| `backoff` | `{ kind: 'exponential', delayMs: <connection retryDelay or 0> }` | `fixed`: `delayMs` before every retry. `exponential`: `delayMs * 2^(n-1)` before the n-th retry. Either is capped at `maxDelayMs`. Delays are whole milliseconds, with no jitter |
| `onEventFailure` | `'drop'` | `'retry'` retries a failed event like a job, into the failing subscriber only |
| `deadLetterChannel` | the connection's `defaultQueueDeadLetterChannel` | Where a dead letter goes; with none, the decision's `channel` is `undefined` and the transport's docs say what it does |
| `groupBy` | unset | SQS FIFO: the message field whose value is the `MessageGroupId` |

In an array route, each option is read from the first item of this connection that declares it (`QueueClient.getRouteOption()`). An invalid `backoff`, `onEventFailure` or `groupBy` fails the boot through the configuration schema, and `consume()` refuses it with `InvalidArgument` before it subscribes. An invalid value never reaches a failure handler.

```ts sample
import { NonRetryableError } from '@spinajs/durable';
import { Event, Job, QueueEvent, QueueJob } from '@spinajs/queue';

// config/queue.ts
export const config = {
  queue: {
    routing: {
      ChargeCard: { channel: '/queue/payments', maxRetries: 5, backoff: { kind: 'exponential', delayMs: 1000, maxDelayMs: 60_000 }, deadLetterChannel: '/queue/payments.dlq' },
      InvoicePaid: { channel: '/topic/invoices', onEventFailure: 'retry', maxRetries: 3, backoff: { kind: 'fixed', delayMs: 5000 } },
    },
  },
};

@Job()
export class ChargeCard extends QueueJob {
  public CardExpired: boolean;

  public async execute() {
    // a retry cannot fix this: dead-lettered at once, and the job row is marked dead
    if (this.CardExpired) throw new NonRetryableError('card expired');
    return 'charged';
  }
}

@Event()
export class InvoicePaid extends QueueEvent {
  public InvoiceId: string;
}
```

## Important behaviour

- **A failed event is dropped by default.** Under `onEventFailure: 'retry'`, an event that uses up `maxRetries` goes to the same dead-letter channel a job would.
- **`NonRetryableError` and `PermanentJobFailure` dead-letter on the first failure** and mark the job row `dead` ([Job tracking](03-job-tracking.md)). `NonRetryableError` is matched by `name`, because a transport may load another copy of `@spinajs/durable`, where `instanceof` fails.
- **Only a `RedeliverLater` itself bypasses the retry count.** The queue throws one for an in-flight duplicate under [event deduplication](12-event-deduplication.md): it is redelivered whatever the policy says, and its `x-retry-count` stays as it was. A handler's own error is decided by the policy, an `IdempotencyInFlight` from an idempotent call inside the handler included, and so is an error that only carries a `RedeliverLater` as its `cause`.
- **A crash is never decided.** An error with `crash: true` stands for a dead process. The transport logs an error and leaves the delivery unsettled: no ack, nack, delete or visibility change. The broker redelivers it once the connection drops or the visibility timeout ends. Until then the subscription holds that delivery, which is one prefetch slot; with a prefetch of 1 it receives nothing more until the connection drops. Outside tests only `FaultInjector` produces such an error.
- **The decision is pure.** It reads no clock, configuration or broker state, so a transport can call it from any failure path and a test can call it directly.

## Related

- [Connections and routing](02-connections-and-routing.md): the routing table these options live in.
- [Event deduplication](12-event-deduplication.md): where `RedeliverLater` comes from.
- [Message ids and headers](13-message-ids-and-headers.md): `QueueHeaders` and how each transport carries them.
