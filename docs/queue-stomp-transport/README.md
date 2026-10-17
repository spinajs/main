# `@spinajs/queue-stomp-transport`

The STOMP-over-WebSocket transport for `@spinajs/queue`. `StompQueueClient` publishes jobs and events to a STOMP broker such as ActiveMQ, waits for a broker receipt on every publish, consumes with per-message acks, reconnects on its own, retries failed jobs and dead-letters the rest.

It does **not** run handlers, track jobs or hydrate message classes: `QueueService` from `@spinajs/queue` does that and calls this transport. It does **not** create queues or topics on the broker. Durable subscriptions, prefetch and scheduled delivery use ActiveMQ headers (`activemq.subscriptionName`, `activemq.prefetchSize`, `AMQ_SCHEDULED_*`); on other brokers those features depend on the broker honouring them. It speaks plain WebSocket through `ws`, not SockJS.

## Install

```sh
npm install @spinajs/queue-stomp-transport
```

## Features

| Feature | What it does |
| --- | --- |
| [STOMP connection](01-stomp-connection.md) | Connection config, how `service: 'StompQueueClient'` selects the client, the first connect at boot, heartbeats, reconnect, readiness, raw `stompjs` options, dispose |
| [Publishing messages](02-publishing-messages.md) | `emit()`: routing to channels, STOMP headers and ActiveMQ scheduling, broker receipts, the publish retry pipeline, buffering while disconnected |
| [Consuming, retries and dead letters](03-consuming-retries-and-dead-letters.md) | `subscribe()` and `unsubscribe()`, acks and prefetch, durable subscriptions, replay after reconnect, job retries with backoff, dead-letter routing |
| [Credential providers](04-credential-providers.md) | `credentialProvider`: a named DI service asked for `login` and `passcode` before every connect, for rotating secrets and tokens |
| [Client factory and client id](05-client-factory-and-client-id.md) | The factory registered for `StompQueueClient`: how it builds the STOMP `client-id`, why it skips the instance cache, how to replace it |
| [Extending the STOMP client](06-extending-the-stomp-client.md) | DI registration under `QueueClient`, subclassing `StompQueueClient`, every protected hook, selecting the subclass per connection |

## Quick start

Import the package once so `StompQueueClient` and its factory register themselves, add a connection with `service: 'StompQueueClient'`, then emit and consume through `QueueService`.

```ts sample
import '@spinajs/queue-stomp-transport';
import { DI } from '@spinajs/di';
import { Job, QueueJob, QueueService } from '@spinajs/queue';

@Job()
export class GenerateInvoice extends QueueJob {
  public OrderId: string;

  public async execute() {
    console.log(`Rendering invoice for order ${this.OrderId}`);
    return { file: `invoices/${this.OrderId}.pdf` };
  }
}

// config/queue.ts
export const config = {
  queue: {
    default: 'activemq',
    routing: {
      GenerateInvoice: { channel: '/queue/invoices', deadLetterChannel: '/queue/invoices.dlq' },
    },
    connections: [
      {
        service: 'StompQueueClient',
        name: 'activemq',
        host: 'ws://activemq.internal:61614/ws',
        login: 'shop',
        password: process.env.ACTIVEMQ_PASSWORD,
        defaultQueueChannel: '/queue/default',
        defaultTopicChannel: '/topic/default',
      },
    ],
  },
};

// worker process
export async function startInvoiceWorker() {
  const queue = await DI.resolve(QueueService);
  await queue.consume(GenerateInvoice);
}

// web process
export async function requestInvoice(orderId: string) {
  return GenerateInvoice.emit({ OrderId: orderId, RetryCount: 3 });
}
```

## Running the package tests

`test/stomp-transport.test.ts` needs a STOMP broker with a WebSocket connector on `ws://localhost:61614/ws`, eg. ActiveMQ Classic. `test/stomp-transport.unit.test.ts` runs without a broker, against a fake `stompjs` client.

```sh
docker run -d --name activemq -p 61613:61613 -p 61614:61614 -p 8161:8161 apache/activemq-classic
npm test
```

## Related packages

- [`@spinajs/queue`](../queue/README.md): `QueueService`, `QueueClient`, `QueueEvent`, `QueueJob`, the `queue.*` configuration and job tracking this transport plugs into.
- [`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md): the AMQP 0-9-1 (RabbitMQ) transport with the same `QueueClient` contract.
- [`@spinajs/queue-sqs-transport`](../queue-sqs-transport/README.md): the Amazon SQS transport.
- [`@spinajs/di`](../di/README.md): the container `StompQueueClient` and its factory are registered in; `@PerInstanceCheck()` and factories.
- [`@spinajs/configuration`](../configuration/README.md): `@AutoinjectService`, which builds one client per `queue.connections` entry.
- [`@spinajs/util`](../util/README.md): `ResiliencePipelineBuilder`, the retry strategy around each publish.
