# `@spinajs/queue-amqp-transport`

The AMQP 0-9-1 (RabbitMQ) transport for `@spinajs/queue`. `AmqpQueueClient` publishes queue messages (jobs and events) to an AMQP broker with publisher confirms, consumes them with manual acks, retries failed jobs through TTL retry queues and dead-letters the rest.

It does **not** run handlers, track jobs or hydrate message classes: `QueueService` from `@spinajs/queue` does that and calls this transport. It does **not** support delayed or scheduled delivery (`ScheduleDelay`, `ScheduleCron`, `SchedulePeriod`, `ScheduleRepeat`): such messages are delivered at once, with a warning. It does **not** use `credentialProvider`, `heartbeatIncoming`, `heartbeatOutgoing`, `connectionTimeout` or `debug` from the connection options.

## Install

```sh
npm install @spinajs/queue-amqp-transport
```

## Features

| Feature | What it does |
| --- | --- |
| [AMQP connection](01-amqp-connection.md) | Connection config, how `host`, credentials and vhost become the amqplib connect target, TLS and socket options, connect, reconnect and dispose |
| [Channel topology](02-channel-topology.md) | How a channel string maps to a fanout exchange or a durable work queue, transient and durable subscriptions, prefetch, routing, the topology hooks |
| [Publishing](03-publishing.md) | `emit()`: publisher confirms, the retry and timeout pipeline, buffering while disconnected, message properties, the publish hooks |
| [Retry and dead-letter](04-retry-and-dead-letter.md) | Ack on success, TTL retry queues with exponential backoff for failed jobs, dead-letter queues, poison messages, the failure hooks |
| [Extending the AMQP client](05-extending-the-amqp-client.md) | DI registration under `QueueClient`, subclassing `AmqpQueueClient`, every protected hook, selecting the subclass per connection |
| [Client factory](06-client-factory.md) | The factory registered for `AmqpQueueClient`: the broker connection name, why it skips the instance cache, how to replace it |

## Quick start

Import the package once so `AmqpQueueClient` registers itself, add a connection with `service: 'AmqpQueueClient'`, then emit and consume through `QueueService`.

```ts sample
import '@spinajs/queue-amqp-transport';
import { DI } from '@spinajs/di';
import { Event, QueueEvent, QueueService } from '@spinajs/queue';

@Event()
export class OrderPlaced extends QueueEvent {
  public OrderId: number;
  public Total: number;
}

// config/queue.ts
export const config = {
  queue: {
    default: 'rabbit',
    routing: {
      OrderPlaced: '/topic/orders',
    },
    connections: [
      {
        service: 'AmqpQueueClient',
        name: 'rabbit',
        host: 'amqp://rabbitmq.internal:5672/shop',
        login: 'shop',
        password: process.env.RABBIT_PASSWORD,
        defaultTopicChannel: '/topic/default',
        defaultQueueChannel: '/queue/default',
        defaultQueueDeadLetterChannel: '/queue/dead-letter',
      },
    ],
  },
};

export async function startOrderListeners() {
  const queue = await DI.resolve(QueueService);

  await queue.consume<OrderPlaced>(OrderPlaced, async (order) => {
    console.log(`Order ${order.OrderId} placed, total ${order.Total}`);
  });
}

export async function placeOrder(orderId: number, total: number) {
  await OrderPlaced.emit({ OrderId: orderId, Total: total });
}
```

## Running the package tests

`test/jobs-amqp-connection.test.ts` needs a running RabbitMQ broker. It connects to `localhost:5672`; set `AMQP_HOST` and `AMQP_PORT` to change that. `test/amqp-transport.unit.test.ts` runs without a broker, against a fake connection.

```sh
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
npm test
```

## Related packages

- [`@spinajs/queue`](../queue/README.md): `QueueService`, `QueueClient`, `QueueEvent`, `QueueJob`, the `queue.*` configuration and job tracking this transport plugs into.
- [`@spinajs/queue-stomp-transport`](../queue-stomp-transport/README.md): the STOMP transport; it uses the same `/topic/` and `/queue/` channel convention.
- [`@spinajs/queue-sqs-transport`](../queue-sqs-transport/README.md): the Amazon SQS transport.
- [`@spinajs/di`](../di/README.md): the container `AmqpQueueClient` and its factory are registered in.
- [`@spinajs/configuration`](../configuration/README.md): `@AutoinjectService`, which builds one client per `queue.connections` entry.
- [`@spinajs/util`](../util/README.md): `ResiliencePipelineBuilder`, the retry and timeout strategies around each publish.
