# Queue service

`QueueService` is the entry point of the package: `emit()`, `consume()`, `stopConsuming()` and `get()`. Every static `emit()`, every `ev()` call and every package that sends messages resolves it from DI, so replacing or extending it changes the pipeline for the whole app: routing, tracking, metrics, or a test double that records messages instead of sending them.

## How it works

1. `@spinajs/queue` registers `DefaultQueueService` with `@Injectable(QueueService)` when it is imported.
2. `DI.resolve(QueueService)` (from `ev()`, your code, or another package) takes the last registration under `QueueService` and builds it once (singleton).
3. While building it, DI injects `Configuration` (`@Config('queue')`), the connection `Map` (`@AutoinjectService('queue.connections', QueueClient)`), the retention service (`@AutoinjectService('queue.retention', JobRetentionService)`) and the `queue` logger. These need the `Configuration` already resolved.
4. `QueueService` extends `AsyncService`, so `DI.resolve(QueueService)` returns a promise.
5. `emit()`, `consume()` and `stopConsuming()` call the protected `getConnectionsForMessage()` to pick connections; see [Connections and routing](02-connections-and-routing.md#how-it-works).
6. `DefaultQueueService.dispose()` disposes the retention service, then every connection, then clears the `Map`.

## API

| Member | Of | Meaning |
| --- | --- | --- |
| `emit(message): Promise<string \| undefined>` | `QueueService`, abstract | Send a message; returns the `JobId` for a job |
| `consume<T>(MessageClass, callback?, subscriptionId?, durable?): Promise<void>` | `QueueService`, abstract | Subscribe and handle |
| `stopConsuming(MessageClass): Promise<void>` | `QueueService`, abstract | Unsubscribe |
| `get(name?): QueueClient` | `QueueService`, abstract | Connection by name, or `queue.default` |
| `Configuration` | `QueueService`, protected, `@Config('queue')` | The `queue` config block |
| `getConnectionsForMessage(message \| MessageClass): string[]` | `QueueService`, protected | Connection names from `queue.routing` |
| `Connections` | `DefaultQueueService`, protected | `Map<string, QueueClient>` keyed by connection name |
| `Retention` | `DefaultQueueService`, protected | The `JobRetentionService`, or `undefined` |
| `Log` | `DefaultQueueService`, protected, `@Logger('queue')` | Queue logger |
| `dispose()` | `DefaultQueueService` | Dispose retention and connections |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue` | `IQueueConfiguration` | see below | | Injected as `QueueService.Configuration` |

The keys are documented on the pages that use them: [Connections and routing](02-connections-and-routing.md#configuration) (`default`, `connections`, `routing`), [Job tracking](03-job-tracking.md#configuration) (`deduplicate`, `progress`), [Job retention](08-job-retention.md#configuration) (`retention`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Queue service | `QueueService`; singleton; the last registration wins | `DefaultQueueService` | none shipped | Subclass `DefaultQueueService` and override `emit()`, `consume()` or `getConnectionsForMessage()`; or implement `QueueService` from scratch. Decorate `@Injectable(QueueService)` (or `DI.register(MyService).as(QueueService)`) in a module imported after `@spinajs/queue` and before the first resolve |

### Queue service: extend the default

Subclass `DefaultQueueService` to keep the tracking flow and change one step. Call `super` for the rest. The subclass must be registered after `@spinajs/queue` is imported (so it is the last registration) and before anything resolves `QueueService` (a singleton is built once).

#### Route messages by tenant

Each tenant has its own broker connection, named `tenant-<id>`; messages carrying a `TenantId` go there, everything else follows `queue.routing`.

```ts sample
import { Constructor, Injectable } from '@spinajs/di';
import { DefaultQueueService, IQueueMessage, QueueMessage, QueueService } from '@spinajs/queue';

@Injectable(QueueService)
export class TenantQueueService extends DefaultQueueService {
  protected getConnectionsForMessage(message: IQueueMessage | Constructor<QueueMessage>): string[] {
    const tenantId = typeof message === 'function' ? undefined : (message as IQueueMessage & { TenantId?: string }).TenantId;
    const tenantConnection = `tenant-${tenantId}`;

    if (tenantId && this.Connections.has(tenantConnection)) {
      return [tenantConnection];
    }

    return super.getConnectionsForMessage(message);
  }
}

// config/queue.ts
export const config = {
  queue: {
    default: 'shared',
    connections: [
      { service: 'StompQueueClient', name: 'shared', host: 'ws://mq-shared.internal:61614/ws' },
      { service: 'StompQueueClient', name: 'tenant-acme', host: 'ws://mq-acme.internal:61614/ws' },
    ],
  },
};
```

`consume()` passes the message class, which has no `TenantId`, so a worker subscribes through `queue.routing`. Run tenant workers with a routing that points at their tenant connection.

### Queue service: custom implementation

Implement `QueueService` directly when you need none of the default behaviour. A common case is a unit-test double that records what the code under test emits.

```ts sample
import { Constructor, DI } from '@spinajs/di';
import { BlackHoleQueueClient, IQueueMessage, QueueClient, QueueEvent, QueueJob, QueueMessage, QueueService, isJob } from '@spinajs/queue';
import { randomUUID } from 'node:crypto';

export class RecordingQueueService extends QueueService {
  public Emitted: IQueueMessage[] = [];
  public Consumed: string[] = [];
  protected Client = new BlackHoleQueueClient({ name: 'recording', transport: 'none', type: 'job' });

  public async emit(message: IQueueMessage | QueueEvent | QueueJob): Promise<string | undefined> {
    this.Emitted.push(message);
    if (isJob(message)) {
      message.JobId = message.JobId ?? randomUUID();
      return message.JobId;
    }
    return undefined;
  }

  public async consume(messageClass: Constructor<QueueMessage>): Promise<void> {
    this.Consumed.push(messageClass.name);
  }

  public async stopConsuming(messageClass: Constructor<QueueMessage>): Promise<void> {
    this.Consumed = this.Consumed.filter((name) => name !== messageClass.name);
  }

  public get(): QueueClient {
    return this.Client;
  }

  public emittedOf(name: string) {
    return this.Emitted.filter((message) => message.Name === name);
  }
}

// in a test setup, before the code under test resolves QueueService
export async function useRecordingQueue() {
  DI.register(RecordingQueueService).as(QueueService);
  return (await DI.resolve(QueueService)) as RecordingQueueService;
}
```

## Important behaviour

- **Every sender goes through `QueueService`.** The static `emit()`, `ev()` and `_ev()` all resolve it, so a replacement also sees messages emitted by other packages (`@spinajs/email`, `@spinajs/users`, `@spinajs/tasks`).
- **Building the service needs the `Configuration` resolved**, because `@AutoinjectService` reads it synchronously. Resolve `Configuration` first, as the framework bootstrap does.
- **`dispose()` does not wait for the connections.** It starts each connection's `dispose()` without awaiting it and clears the `Map` at once.
- **Message hooks and tracking hooks live in `DefaultQueueService`.** A from-scratch implementation runs none of them unless it calls them itself; `runBeforeEmit()`, `runAroundHandle()` and `tracked()` are not exported.

## Best practices

- Prefer extending `DefaultQueueService` over a fresh implementation, so hooks, tracking and deduplication keep working.
- Override the protected `getConnectionsForMessage()` for routing rules, rather than `emit()` and `consume()` separately; all three entry points use it.
- Use a recording `QueueService` in unit tests instead of a black-hole connection when the test asserts what was sent.

## Related

- [Events and jobs](01-events-and-jobs.md): the emit and consume flows of `DefaultQueueService`.
- [Connections and routing](02-connections-and-routing.md): what `getConnectionsForMessage()` reads.
- [Job tracking](03-job-tracking.md): the per-job flow inside `consume()`.
- [Multiple implementations](../di/06-multiple-implementations.md): why the last registration wins.
