# `@spinajs/queue-amqp-transport`

AMQP 0-9-1 ( RabbitMQ ) transport for the [`@spinajs/queue`](../queue) module. Lets you publish and
consume queue messages ( jobs & events ) through an AMQP compatible broker.

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
        transport: 'AmqpQueueClient',
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

`host` may also be a full url ( `amqp://user:pass@host/vhost` ), in which case the discrete
`port`/`login`/`password` fields are ignored.

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
