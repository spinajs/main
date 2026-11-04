# Message ids and headers

Every message `QueueService.emit()` sends carries a `MessageId`, and any message can carry `Headers`. The id names one message across retries, redeliveries and transports, so logs and broker tools can follow it. Only jobs are deduplicated today, by `JobId` (`queue.deduplicate`, see [Job tracking](03-job-tracking.md)); an event delivered twice is handled twice. Headers carry metadata outside the message's own fields: a trace context, a tenant, or the retry bookkeeping a transport writes.

## How it works

1. `emit()` sets `MessageId` to a random uuid v4 unless the message already has one. A caller-set id is kept as is. The id is written onto the object you pass, so emitting the same instance again sends the same `MessageId`.
2. For a job, `JobId` defaults to the `MessageId`. A caller-set `JobId` is kept, so the two can differ. `queue_jobs.JobId` is `varchar(36)`: a job with a caller-set `MessageId` longer than 36 characters needs an explicit `JobId`. `emit()` still returns the `JobId` for a job and `undefined` for an event.
3. The message body still carries both fields, since every transport sends the whole message as JSON. Each transport also maps them onto the broker's own metadata, so broker tools can see them:

   | Transport | `MessageId` | `Headers` |
   | --- | --- | --- |
   | AMQP | the `messageId` property and the `x-spinajs-message-id` header | AMQP headers |
   | STOMP | the `x-spinajs-message-id` header (STOMP's `message-id` belongs to the broker) | STOMP headers, except the frame headers (`destination`, `receipt`, `content-type`, `message-id`, …) |

4. On receipt the transport fills in `MessageId` from the broker metadata when the body has none (a message published with broker tools or a foreign producer), and merges the standard headers it finds on the delivery into `Headers`. The broker's values win, because retries and dead letters rewrite them. Other broker headers (`x-death`, `destination`, `subscription`, …) stay out of `Headers`.
5. `QueueMessage.hydrate()` copies both fields onto a message class instance, so a handler reads `this.MessageId` and `this.Headers`.

## Standard headers

`QueueHeaders` names the headers every transport writes and reads the same way:

| Key | Header | Written by |
| --- | --- | --- |
| `MessageId` | `x-spinajs-message-id` | `emit()` through the transport, and copied onto retries and dead letters |
| `RetryCount` | `x-retry-count` | The transport, on a retry and on a dead letter |
| `Error` | `x-error` | The transport, on a dead letter |
| `OriginalDestination` | `x-original-destination` | STOMP only for now, on a dead letter |
| `TraceParent` | `traceparent` | Reserved for tracing (W3C trace context) |

`RetryCount`, `Error` and `OriginalDestination` belong to the transport: on publish, AMQP and STOMP drop them from `Headers`, so a received message emitted again does not carry a stale retry count. `readQueueHeaders(raw)` picks the standard headers out of a broker's raw headers as strings, and `withoutTransportHeaders(headers)` drops the transport's own; a custom transport calls them on receipt and on publish.

```ts sample
import { QueueEvent, Event, QueueHeaders } from '@spinajs/queue';

@Event()
export class OrderPlaced extends QueueEvent {
  public OrderId: number;
}

// a deterministic id: both emits of one order carry the same MessageId in logs and broker tools
export async function placeOrder(orderId: number, traceparent: string) {
  await OrderPlaced.emit({ OrderId: orderId, MessageId: `order-placed:${orderId}`, Headers: { [QueueHeaders.TraceParent]: traceparent } });
}
```

## Testing with the memory transport

`@spinajs/queue/testing` ships `MemoryQueueClient`, a transport without a server, and `describeQueueTransportConformance`, the shared transport cases (mocha).

```ts
queue: {
  default: 'memory',
  connections: [{ service: 'MemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/test', defaultTopicChannel: '/topic/test', options: { broker: 'test', deferred: true } }],
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `options.broker` | `'default'` | Clients that name the same broker share subscribers. `MemoryBroker.drop(name)` forgets one |
| `options.deferred` | `false` | `false`: an event reaches every subscriber of the broker during `emit()`; a job is only recorded, and `deliver(message)` hands it to this client's subscribers. `true`: `emit()` only queues, `deliverAll()` delivers |

With `deferred: true` the client behaves like a broker that you drive by hand, with no timers:

- `published` lists every message the client accepted, in order. Nothing removes an entry. A subscriber receives a copy whose `Headers` also carry `x-spinajs-message-id`, as on AMQP and STOMP.
- `deliverAll()` delivers the queued messages in publish order, by channel. An event goes to every subscription on its channel, a job to the first one. A job waits in its queue until a consumer subscribes; an event nobody listens to is dropped.
- A message is settled only after its callback resolved. One whose callback rejected stays queued for the next `deliverAll()`: an event goes again to the subscriptions that rejected it, a job to whoever consumes its channel by then. Messages published during a `deliverAll()` wait for the next call.

A transport package proves its semantics by running the conformance cases against its own harness:

```ts
import { describeQueueTransportConformance } from '@spinajs/queue/testing';

describeQueueTransportConformance('MyTransport', async () => ({
  client,                         // a connected QueueClient with default queue and topic channels
  deliverAll: () => drainBroker(),
  advance: (ms) => clock.advance(ms),
  deadLetters: (channel) => readDeadLetters(channel),
  dispose: () => client.dispose(),
}));
```

The suite reads its channels from the client's `defaultQueueChannel` and `defaultTopicChannel`. It covers an ack on success and a `MessageId` and `Headers` round trip. Retry and dead-letter cases are not in the suite yet.
