# `@spinajs/queue-sqs-transport`

The Amazon SQS transport for `@spinajs/queue`. `SqsQueueClient` sends queue messages (events and jobs) to SQS queues and consumes them with a long-poll loop per queue URL.

It does **not** create queues, set redrive policies or support FIFO queues out of the box. Create the queues and their dead-letter queues in AWS (or LocalStack) first; [Extending the SQS client](04-extending-the-sqs-client.md) shows a FIFO subclass. It has no SNS topics either: an "event" goes to a queue URL like a job does.

## Install

```sh
npm install @spinajs/queue-sqs-transport
```

## Features

| Feature | What it does |
| --- | --- |
| [SQS connection](01-sqs-connection.md) | Connection config, how `queue.connections[].service` selects `SqsQueueClient`, one client per connection name, AWS region, endpoint and credentials |
| [Publishing messages](02-publishing-messages.md) | `emit()`: queue URL routing, the JSON envelope, fan-out to several queues, and what SQS ignores |
| [Consuming messages](03-consuming-messages.md) | `subscribe()`: the long-poll loop, ack by delete, redelivery and dead-lettering through SQS, receive-error backoff, `unsubscribe()` and `dispose()` |
| [Extending the SQS client](04-extending-the-sqs-client.md) | DI registration and lifetime, registering a factory, subclassing `SqsQueueClient` (FIFO send, SNS unwrapping, rotating credentials), writing your own `QueueClient` |

## Quick start

Configure one SQS connection, route a job to its queue URL, import the package once so `SqsQueueClient` registers, then emit and consume through `QueueService`.

```ts sample
import '@spinajs/queue-sqs-transport';
import { DI } from '@spinajs/di';
import { Job, QueueJob, QueueService } from '@spinajs/queue';

// config/queue.ts
export const config = {
  queue: {
    default: 'sqs',
    routing: {
      ResizeImageJob: 'https://sqs.eu-central-1.amazonaws.com/123456789012/image-resize',
    },
    connections: [
      {
        service: 'SqsQueueClient',
        name: 'sqs',
        options: { region: 'eu-central-1' },
      },
    ],
  },
};

@Job()
export class ResizeImageJob extends QueueJob {
  public ImageId: string;

  public async execute() {
    return { resized: this.ImageId };
  }
}

export async function startWorker() {
  const queue = await DI.resolve(QueueService);
  await queue.consume(ResizeImageJob);
}

export async function requestResize(imageId: string) {
  return ResizeImageJob.emit({ ImageId: imageId });
}
```

## Related packages

- [`@spinajs/queue`](../queue/README.md): `QueueService`, `QueueClient`, events, jobs, routing and job tracking; this package is one of its transports.
- [`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md): the AMQP transport.
- [`@spinajs/queue-stomp-transport`](../queue-stomp-transport/README.md): the STOMP transport, for ActiveMQ and similar brokers.
- [`@spinajs/di`](../di/README.md): `@Injectable`, `@PerInstanceCheck` and factory registrations used to select and replace the client.
- [`@spinajs/configuration`](../configuration/README.md): `@AutoinjectService`, which builds one client per `queue.connections` entry.
