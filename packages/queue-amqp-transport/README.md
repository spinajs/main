# `@spinajs/queue-amqp-transport`

AMQP 0-9-1 ( RabbitMQ ) transport for the [`@spinajs/queue`](../queue) module. Lets you publish and
consume queue messages ( jobs & events ) through an AMQP compatible broker.

## Documentation

Full documentation lives in [`docs/queue-amqp-transport`](../../docs/queue-amqp-transport/README.md):

- [AMQP connection](../../docs/queue-amqp-transport/01-amqp-connection.md)
- [Channel topology](../../docs/queue-amqp-transport/02-channel-topology.md)
- [Publishing](../../docs/queue-amqp-transport/03-publishing.md)
- [Retry and dead-letter](../../docs/queue-amqp-transport/04-retry-and-dead-letter.md)
- [Extending the AMQP client](../../docs/queue-amqp-transport/05-extending-the-amqp-client.md)
- [Client factory](../../docs/queue-amqp-transport/06-client-factory.md)

## Topology

The transport maps the queue `channel` string onto AMQP primitives using a simple, STOMP compatible
convention:

| Channel prefix      | AMQP primitive            | Semantics                                            |
| ------------------- | ------------------------- | --------------------------------------------------- |
| `/topic/...`        | `fanout` exchange         | Events / pub-sub. Every subscriber gets every message. |
| anything else       | durable work queue        | Jobs. A message is delivered to a single consumer.  |

The topic prefix can be changed per connection via `options.topicPrefix`.

- **Transient event subscription** – an exclusive, auto-deleted, server-named queue bound to the fanout exchange.
- **Durable event subscription** – a stable, durable queue named after `subscriptionId`; messages keep
  accumulating while no consumer is attached and are delivered on re-subscribe.

## Usage

Register the transport in your queue configuration:

```js
import '@spinajs/queue-amqp-transport';

const config = {
  queue: {
    default: 'amqp',
    routing: {
      // optional per-message channel routing
      MyEvent: '/topic/my-events',
      MyJob: '/queue/my-jobs',
    },
    connections: [
      {
        name: 'amqp',
        service: 'AmqpQueueClient',
        host: 'localhost',
        port: 5672,
        login: 'guest',
        password: 'guest',
        defaultTopicChannel: '/topic/default',
        defaultQueueChannel: '/queue/default',
        options: {
          // forwarded to amqplib connect ( heartbeat, vhost, tls ... )
          vhost: '/',
          // topicPrefix: '/topic/',
        },
      },
    ],
  },
};
```

`host` may also be a full url ( `amqp://user:pass@host/vhost` ). Its port and credentials win;
`port` and `login`/`password` are used only when the url has none.

## Not yet supported

Delayed / scheduled delivery ( `ScheduleDelay`, `ScheduleCron`, `SchedulePeriod`, `ScheduleRepeat` ) is
not implemented yet — RabbitMQ requires the delayed-message plugin or a TTL + dead-letter topology for
this. When these fields are set the message is delivered immediately and a warning is logged.

## Tests

The test suite expects a running RabbitMQ broker. By default it connects to `localhost:5672`; override
with `AMQP_HOST` / `AMQP_PORT` environment variables.

```
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
npm test
```
