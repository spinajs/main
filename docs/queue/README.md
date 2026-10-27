# `@spinajs/queue`

Message queue abstraction for SpinaJS: typed events and jobs, a `QueueService` that emits and consumes them through pluggable transports (`QueueClient`), config-driven routing, and job tracking in the `queue_jobs` table with retries, progress, deduplication and retention.

It does **not** talk to a broker by itself. The only transport it ships is `BlackHoleQueueClient`, which drops every message; install a transport package for a real broker. Emitting does **not** touch the database: the consumer writes the job row.

## Install

```sh
npm install @spinajs/queue
```

Pick a transport:

| Package | Transport class | Broker |
| --- | --- | --- |
| `@spinajs/queue-stomp-transport` | `StompQueueClient` | ActiveMQ, RabbitMQ (STOMP) |
| [`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md) | `AmqpQueueClient` | RabbitMQ (AMQP 0-9-1) |
| [`@spinajs/queue-sqs-transport`](../queue-sqs-transport/README.md) | `SqsQueueClient` | Amazon SQS |

## Features

| Feature | What it does |
| --- | --- |
| [Events and jobs](01-events-and-jobs.md) | `QueueEvent`, `QueueJob`, `@Event()`, `@Job()`, `emit()`, `ev()`, `consume()`, `stopConsuming()`, message options and custom message classes |
| [Connections and routing](02-connections-and-routing.md) | `queue.default`, `queue.connections`, `queue.routing`: which connection and channel a message uses, dead-letter channels |
| [Job tracking](03-job-tracking.md) | `JobModel` and `queue_jobs`: statuses, retries, `onFailed()`, progress throttling, deduplication, initiator ownership, query scopes, migrations |
| [Transports](04-transports.md) | `QueueClient`: the transport contract, `BlackHoleQueueClient`, writing and registering your own transport |
| [Credential providers](05-credential-providers.md) | `IQueueCredentialsProvider`: broker credentials fetched before each connect, selected by `credentialProvider` |
| [Message hooks](06-message-hooks.md) | `QueueMessageHook`: code that runs before every emit and around every handler |
| [Tracking hooks](07-tracking-hooks.md) | `QueueTrackingHook`: code that wraps every read and write of the job table |
| [Job retention](08-job-retention.md) | `JobRetentionService`: periodic purge of old job rows, selected by `queue.retention.service` |
| [Queue service](09-queue-service.md) | `QueueService` and `DefaultQueueService`: replacing or extending the emit and consume pipeline |

## Quick start

Define a job, consume it in a worker, emit it from the app. With the shipped config every message goes to `BlackHoleQueueClient`; route it to a real transport in `queue.connections` (see [Connections and routing](02-connections-and-routing.md)).

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Job, JobProgressCallback, QueueJob, QueueService } from '@spinajs/queue';

@NewInstance()
@Job()
export class GenerateInvoicePdf extends QueueJob {
  public InvoiceId: number;

  public async execute(progress: JobProgressCallback) {
    await progress(50, { phase: 'rendering' });
    return { file: `invoices/${this.InvoiceId}.pdf` };
  }
}

// worker process
export async function startWorker() {
  const queue = await DI.resolve(QueueService);
  await queue.consume(GenerateInvoicePdf);
}

// web process: returns the JobId to poll the job's status with
export async function requestInvoicePdf(invoiceId: number): Promise<string | undefined> {
  return GenerateInvoicePdf.emit({ InvoiceId: invoiceId, RetryCount: 2 });
}
```

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): `queue.*` config, and `@AutoinjectService`, which builds the transports from `queue.connections`; see [Config-selected services](../configuration/08-config-selected-services.md).
- [`@spinajs/di`](../di/README.md): every extension point here is a DI registration.
- [`@spinajs/orm`](../orm/README.md): `JobModel` and the `queue_jobs` migrations run on the `queue` connection.
- [`@spinajs/queue-http-progress`](../queue-http-progress/README.md): an HTTP route that reads a job's `queue_jobs` row.
- `@spinajs/authz-queue`: a `QueueMessageHook` that runs handlers as the emitting principal; its `/jobs` subpath adds a `QueueTrackingHook` and guards `JobModel`.
- [`@spinajs/email`](../email/README.md), [`@spinajs/http-lazy-file-uploader`](../http-lazy-file-uploader/README.md): packages that ship jobs and events.
