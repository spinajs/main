# Delivery contract

When a handler fails, a transport must choose between retrying the message, moving it to a dead-letter channel and dropping it. `decideDelivery()` makes that choice. It is one pure function, so every transport that executes it behaves the same way and can be tested against the same cases. The transport then carries out the answer with its own broker primitive: a delayed queue, a scheduled republish or a visibility change.

The policy comes from `queue.routing` and from the connection, through `resolveDeliveryPolicy()`. `MemoryQueueClient` in deferred mode (`@spinajs/queue/testing`) and `SqsQueueClient` with `options.retryMode: 'transport'` ([Consuming messages](../queue-sqs-transport/03-consuming-messages.md#retry-modes)) execute the decision. The AMQP and STOMP transports do not yet, and SQS in its default `'redrive'` mode leaves every failure to the visibility timeout and the queue's redrive policy; each keeps the retry rules its own docs describe.

## The decision

`decideDelivery(message, attempt, error, policy)` checks these rules in order. `attempt` is the received copy's `x-retry-count`, which is 0 on the first delivery.

| # | Condition | Decision |
| --- | --- | --- |
| 1 | the error has `crash: true` | throws `InvalidArgument`: a crash is never decided |
| 2 | `isRedeliverLater(error)` | `retry`, `attempt` unchanged, `delayMs` from the error, `forced: true` |
| 3 | `UnparseableMessageError` (the body could not be parsed) | `dead-letter`, `reason: 'unparseable'` |
| 4 | an event, and `onEventFailure` is `'drop'` (the default) | `ack`, `dropped: true` |
| 5 | `PermanentJobFailure`; a `NonRetryableError` or a subclass; an error named `NonRetryableError` from another copy of `@spinajs/durable` | `dead-letter`, `reason: 'non-retryable'` |
| 6 | `attempt < maxRetries` | `retry` with `attempt + 1`, after `backoffDelay(backoff, attempt + 1)` |
| 7 | otherwise | `dead-letter`, `reason: 'exhausted'` |

Every `delayMs` in a decision is a whole number of milliseconds from 0 to 2^31 - 1 (about 24.8 days), the longest a Node timer waits. A `RedeliverLater` delay that is not a number or is below 0 becomes 0, and a longer delay, a `RedeliverLater`'s or a backoff's, is cut to that limit.

Every `retry` and `dead-letter` decision carries these headers. The transport adds `x-original-destination`, because the decision does not know the channel.

| Header | Value |
| --- | --- |
| `x-error` | the error's message, or its name when the message is empty, cut at 1024 characters (`DELIVERY_ERROR_MAX_LENGTH`); for an unparseable body it starts with `unparseable message body:`; `unknown error` for a rejection value that cannot be turned into text |
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
| `groupBy` | unset | SQS FIFO: the message field whose value is the `MessageGroupId`; a blank name is refused |

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
- **`NonRetryableError` and `PermanentJobFailure` dead-letter on the first failure** and mark the job row `dead` ([Job tracking](03-job-tracking.md)). `NonRetryableError` is matched with `instanceof`, which covers subclasses that rename themselves, and by the name `NonRetryableError`, because a transport may load another copy of `@spinajs/durable`, where `instanceof` fails. `consume()` marks the row `dead` whatever the transport does. A transport that executes the decision, such as the deferred `MemoryQueueClient` or SQS in `retryMode: 'transport'`, dead-letters the message at once. A transport that does not execute it yet retries the message, and the retried copy is acked without running, so it never reaches the dead-letter channel. SQS in `'redrive'` mode is one of those: the copy comes back after the visibility timeout and is deleted without running.
- **Only a `RedeliverLater` itself bypasses the retry count.** The queue throws one under [event deduplication](12-event-deduplication.md) for an in-flight duplicate, or a claim that failed before the handler ran: it is redelivered whatever the policy says, and its `x-retry-count` stays as it was. A handler's own error is decided by the policy, an `IdempotencyInFlight` from an idempotent call inside the handler included, and so is an error that only carries a `RedeliverLater` as its `cause`.
- **A crash is never decided.** An error with `crash: true` stands for a dead process. The transport logs an error and leaves the delivery unsettled: no ack, nack, delete or visibility change. The broker redelivers it once the connection drops or the visibility timeout ends. Until then the subscription holds that delivery, which is one prefetch slot; with a prefetch of 1 it receives nothing more until the connection drops. Outside tests only `FaultInjector` produces such an error.
- **The decision is pure.** It reads no clock, configuration or broker state, so a transport can call it from any failure path and a test can call it directly.

## Testing a transport

`@spinajs/queue/testing` holds the cases every transport runs (mocha). A transport package registers them with `describeQueueTransportConformance(name, factory, options?)`. `factory` returns a fresh `TransportHarness` for each case:

| Member | Meaning |
| --- | --- |
| `client` | A connected `QueueClient` whose `defaultQueueChannel`, `defaultTopicChannel` and `defaultQueueDeadLetterChannel` are set; the cases read their channels from them |
| `deliverAll()` | Returns once everything the broker can deliver now was handed out and settled |
| `advance(ms)` | Moves the broker's clock forward. A harness on a real broker waits instead, and may cap the wait a little above `CONFORMANCE_MAX_DELAY_MS` (5000), the longest delay the cases use |
| `deadLetters(channel)` | The dead letters on a channel, each as `{ message, headers }`. `deadLetterBody(body)` turns a raw body into that `message`, or into the stand-in for a body that is not a message |
| `injectRaw?(channel, body)` | Optional: puts a raw body on a channel, past the transport's own serialization |
| `redeliverUnsettled?()` | Optional: makes the broker hand out again what a consumer received and never settled (a dropped connection, an expired visibility timeout) |
| `dispose()` | Tears the harness down |

The harness configuration passes `conformanceRouting(extra?)` as `queue.routing`. It routes every message the cases send (`CONFORMANCE_ROUTING`), each route with `extra` added, so an SQS FIFO harness can pass `{ groupBy: … }`. The cases need no real sleeps: a harness on the memory transport drives an injected `FakeClock`.

```ts
import { conformanceRouting, describeQueueTransportConformance } from '@spinajs/queue/testing';

// queue.routing of the harness configuration: conformanceRouting()
describeQueueTransportConformance('MyTransport', () => myHarness(), {
  skip: { 'dead-letters an unparseable body': 'the broker refuses a body that is not JSON' },
});
```

`skip` names cases by title, each with its reason, and shows them as pending; an unknown title fails the registration. A case that needs `injectRaw` or `redeliverUnsettled` is pending on a harness without it. The cases, and the transport each one catches:

| Case | Fails for a transport that |
| --- | --- |
| acks a message whose handler succeeded | redelivers or dead-letters a handled message |
| keeps the MessageId and headers across a round trip | loses the `MessageId` or the message's `Headers` |
| retries a job maxRetries times, then dead-letters it with x-error, x-retry-count and x-original-destination | retries without limit, acks the failure, or leaves out a header |
| dead-letters a PermanentJobFailure at once | retries it |
| dead-letters a NonRetryableError at once | retries it |
| does not deliver a retry before its delay | ignores `delayMs` |
| drops a failed event by default | retries or dead-letters an event under `onEventFailure: 'drop'`, or acks one routed with `'retry'` |
| retries an event with onEventFailure retry, only to the subscriber that failed | retries into every subscriber, retries without limit, or acks the failure |
| redelivers an event whose handler asked for a later delivery, whatever onEventFailure says | drops a `RedeliverLater`, or redelivers it before its delay |
| leaves a crashed delivery unsettled, so the broker redelivers it | acks, dead-letters or retries a crash (needs `redeliverUnsettled`) |
| dead-letters an unparseable body | hands it to the handler or drops it (needs `injectRaw`) |

`MemoryQueueClient` runs every case but the last, since it has no wire format. Its `redeliverUnsettled` does nothing: a crashed delivery stays in the memory broker, and the next `deliverAll()` hands it out again.

## Related

- [Connections and routing](02-connections-and-routing.md): the routing table these options live in.
- [Event deduplication](12-event-deduplication.md): where `RedeliverLater` comes from.
- [Message ids and headers](13-message-ids-and-headers.md): `QueueHeaders` and how each transport carries them.
