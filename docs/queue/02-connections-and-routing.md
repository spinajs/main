# Connections and routing

`queue.connections` lists the transports the app talks to, each under a name; `queue.routing` sends each message type to a connection and to a channel on that connection. A message with no route goes to the `queue.default` connection and to that connection's default channel.

## How it works

Building the connections, when `QueueService` is first resolved:

1. `DefaultQueueService.Connections` is decorated `@AutoinjectService('queue.connections', QueueClient)`.
2. For each entry, DI finds the `QueueClient` registration whose class name equals `entry.service` (`ServiceNotFound` otherwise) and resolves it with the whole entry as the constructor's `Options`.
3. The clients are stored in a `Map` keyed by `ServiceName`, which `QueueClient` returns as `Options.name`.

Choosing the connections, in `QueueService.getConnectionsForMessage(message)` (used by `emit()`, `consume()` and `stopConsuming()`):

1. It looks up `queue.routing[message.Name]`.
2. No route, or a string route (a channel name): the `queue.default` connection.
3. An object route: its `connection`, or `queue.default`.
4. An array route: the `connection` of each object item, `queue.default` for each string item, duplicates removed.

Choosing the channels, in `QueueClient.getChannelForMessage(message)` (called by the transport):

1. It looks up `queue.routing[message.Name]`.
2. No route: the connection's `defaultQueueChannel` for a job, `defaultTopicChannel` for an event, with a warning log.
3. A string route: that channel.
4. An object route: its `channel`, or the default channel as in step 2.
5. An array route: each string item, or each object's `channel` (or the default channel), duplicates removed.

Choosing the dead-letter channel, in `QueueClient.getDeadLetterChannelForMessage(message)`: the route's `deadLetterChannel`, else the first array item that has one, else the connection's `defaultQueueDeadLetterChannel`, else `undefined`.

`QueueService.get(name?)` returns the client named `name`, or the `queue.default` client.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.default` | `string` | `'black-hole'` | a `queue.connections[].name` | Connection for messages without a route, or whose route names no connection |
| `queue.connections` | `IQueueConnectionOptions[]` | `[{ name: 'black-hole', service: 'BlackHoleQueueClient' }]` | | Transports to build. Each entry is passed whole to the transport's constructor |
| `queue.connections[].service` | `string` | | class name of a registered `QueueClient` | Which transport class to build |
| `queue.connections[].name` | `string` | | unique | Connection name used by `queue.default`, routes and `QueueService.get()` |
| `queue.connections[].defaultQueueChannel` | `string` | | broker channel | Channel for jobs without a route |
| `queue.connections[].defaultTopicChannel` | `string` | | broker channel | Channel for events without a route |
| `queue.connections[].defaultQueueDeadLetterChannel` | `string` | | broker channel | Dead-letter channel when the route sets none |
| `queue.connections[].host`, `port`, `login`, `password`, `clientId`, `queue`, `options` | | | | Connection details, read by the transport |
| `queue.connections[].reconnectDelay`, `heartbeatIncoming`, `heartbeatOutgoing`, `connectionTimeout`, `receiptTimeout` | `number` (ms) | | | Timing, read by the transports that support it |
| `queue.connections[].retryDelay` | `number` (ms) | | | Base delay of the transport's retry backoff for failed jobs |
| `queue.connections[].debug` | `boolean` | | | Log transport protocol chatter at `debug` instead of `trace` |
| `queue.connections[].credentialProvider` | `string` | | DI name of an `IQueueCredentialsProvider` | See [Credential providers](05-credential-providers.md) |
| `queue.routing` | `IQueueMessageRoutingOptions` | unset | | Routes keyed by message class name |
| `queue.routing.<Name>` | `string \| IMessageRoutingOption \| (string \| IMessageRoutingOption)[]` | | | A channel, an option object, or several |
| `queue.routing.<Name>.connection` | `string` | `queue.default` | a connection name | Connection of the message |
| `queue.routing.<Name>.channel` | `string` | connection's default channel | broker channel | Channel of the message |
| `queue.routing.<Name>.deadLetterChannel` | `string` | connection's `defaultQueueDeadLetterChannel` | broker channel | Where the transport moves a message it gives up on |

Each transport decides which connection keys it reads; check its docs. `IQueueConnectionOptions` declares `transport` and `type` as required, but neither the queue nor the shipped transports read them, and `service` is not part of the type.

```ts
// config/queue.ts
export default {
  queue: {
    default: 'broker',
    connections: [
      {
        service: 'StompQueueClient',
        name: 'broker',
        host: 'ws://activemq.internal:61614/ws',
        login: 'app',
        password: 'secret',
        defaultQueueChannel: '/queue/jobs',
        defaultTopicChannel: '/topic/events',
        defaultQueueDeadLetterChannel: '/queue/jobs-dlq',
      },
      { service: 'BlackHoleQueueClient', name: 'black-hole' },
    ],
    routing: {
      GenerateInvoicePdf: { connection: 'broker', channel: '/queue/pdf', deadLetterChannel: '/queue/pdf-dlq' },
      UserRegistered: '/topic/users',
      AuditTrailEvent: { connection: 'black-hole' },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Connection map | `QueueClient` implementations, built per `queue.connections` entry by `@AutoinjectService` in `DefaultQueueService` | `BlackHoleQueueClient` as `black-hole` | `StompQueueClient`, `AmqpQueueClient`, `SqsQueueClient`, your own | Add an entry with your class name in `service`; see [Transports](04-transports.md) |
| Connection selection | `QueueService.getConnectionsForMessage()` (protected) | `QueueService` | | Override in a `QueueService` subclass; see [Queue service](09-queue-service.md#route-messages-by-tenant) |
| Channel selection | `QueueClient.getChannelForMessage()`, `getDeadLetterChannelForMessage()` (public) | `QueueClient` | | Override in a transport subclass; see [Transports](04-transports.md) |

## Important behaviour

- **A string route never selects a connection.** It names a channel on `queue.default`. Use `{ connection, channel }` to send a message elsewhere.
- **Routes are keyed by class name.** Renaming a message class silently drops its route; the message then goes to the default connection and channel, with a warning log.
- **An array route subscribes every routed connection to every channel of the route.** `getChannelForMessage()` ignores the `connection` field of the items, so `[{ connection: 'a', channel: 'x' }, { connection: 'b', channel: 'y' }]` makes both `a` and `b` use `x` and `y`.
- **A job routed to several connections is delivered once per connection**, with one `JobId` and so one job row. With `queue.deduplicate` on, a delivery that arrives after another one finished is skipped; deliveries that overlap both run.
- **The shipped default sends everything to `BlackHoleQueueClient`.** Packages emit events (logins, sent mails) whether or not the app runs a broker; with the default, these vanish and `emit()` resolves.
- **Two connections of the same transport class need distinct instances.** The class must be `@PerInstanceCheck()` or `@NewInstance()`; the shipped transports are. A singleton transport is built once, and every entry gets that one instance.
- **`QueueService.get(name)` returns `undefined` for an unknown name**, despite its `QueueClient` return type.

## Best practices

- Route jobs with `{ connection, channel, deadLetterChannel }` objects, so moving a job to another broker is a config change.
- Give every job connection a `defaultQueueDeadLetterChannel`; without one, a transport has nowhere to put a poison message.
- Keep `black-hole` in `queue.connections` and route events nobody consumes there explicitly, instead of leaving them on the default.

## Patterns and antipatterns

```ts
// Don't: a string is a channel on queue.default, not a connection name
routing: { GenerateInvoicePdf: 'pdf-broker' }

// Do
routing: { GenerateInvoicePdf: { connection: 'pdf-broker', channel: '/queue/pdf' } }
```

## Examples

### Send audit events to a second broker, jobs to the main one

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Event, QueueEvent, QueueService } from '@spinajs/queue';

@NewInstance()
@Event()
export class AuditTrailEvent extends QueueEvent {
  public Actor: string;
  public Action: string;
}

// config/queue.ts
export const config = {
  queue: {
    default: 'main',
    connections: [
      { service: 'StompQueueClient', name: 'main', host: 'ws://activemq.internal:61614/ws', defaultQueueChannel: '/queue/jobs', defaultTopicChannel: '/topic/events' },
      { service: 'StompQueueClient', name: 'audit', host: 'ws://audit-broker.internal:61614/ws', defaultTopicChannel: '/topic/audit' },
    ],
    routing: {
      AuditTrailEvent: { connection: 'audit', channel: '/topic/audit/trail' },
    },
  },
};

export async function recordAudit(actor: string, action: string) {
  await AuditTrailEvent.emit({ Actor: actor, Action: action });
}

export async function auditConnectionChannel() {
  const queue = await DI.resolve(QueueService);
  return queue.get('audit').getChannelForMessage(AuditTrailEvent);
  // ['/topic/audit/trail']
}
```

## Related

- [Transports](04-transports.md): the `QueueClient` classes named in `service`.
- [Config-selected services](../configuration/08-config-selected-services.md): how `@AutoinjectService` turns `queue.connections` into a `Map`.
- [Events and jobs](01-events-and-jobs.md): what is routed.
- [`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md), [`@spinajs/queue-sqs-transport`](../queue-sqs-transport/README.md): transport-specific connection keys.
