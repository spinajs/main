# Transports

A transport is a `QueueClient`: the class that moves messages to and from one broker connection. `QueueService` builds one client per `queue.connections` entry and calls `emit()`, `subscribe()` and `unsubscribe()` on it. Write your own to support another broker, or extend a shipped one to change channel naming or delivery.

## How it works

1. A transport module registers its class with `@Injectable(QueueClient)` when it is imported. The shipped broker transports also register a factory under their own class key (`DI.register(factory).as(StompQueueClient)`).
2. When `QueueService` is resolved, `@AutoinjectService('queue.connections', QueueClient)` finds the class named by each entry's `service` and resolves it with the entry as `Options`. A factory registered under that class builds the instance instead of DI. See [Connections and routing](02-connections-and-routing.md#how-it-works).
3. `QueueClient` extends `AsyncService`, so DI awaits its `resolve()`: connect to the broker there.
4. `QueueService.emit()` calls `client.emit(message)`. The client picks channels with `getChannelForMessage(message)` and publishes.
5. `QueueService.consume()` calls `client.subscribe(MessageClass, handler, subscriptionId, durable)`. The client listens on `getChannelForMessage(MessageClass)` and calls `handler(wireMessage)` for each message.
6. A handler that resolves means "processed": acknowledge. A handler that rejects means "failed": redeliver, retry later, or move the message to `getDeadLetterChannelForMessage(message)`.
7. `QueueService.dispose()` calls `dispose()` on every client: close the connection there.

## API

`QueueClient` (abstract, extends `AsyncService`, implements `IInstanceCheck` and `IMappableService`):

| Member | Kind | Meaning |
| --- | --- | --- |
| `constructor(Options: IQueueConnectionOptions)` | | The `queue.connections` entry |
| `Options` | public field | The entry, as configured |
| `Name`, `ServiceName` | getters | `Options.name`; the key in the connection `Map` |
| `Log` | protected, `@Logger('queue')` | Queue logger |
| `Routing` | protected, `@Config('queue.routing')` | The routing table |
| `emit(message)` | abstract | Publish. Resolve only once the broker has taken custody (publisher confirm, receipt), so persistent jobs are delivered at least once |
| `subscribe(messageClass \| channel, callback, subscriptionId?, durable?)` | abstract, two overloads | Listen. With a class, listen on all its routed channels |
| `unsubscribe(messageClass \| channel, removeDurable?)` | abstract, two overloads | Stop listening; `removeDurable` also drops the durable subscription |
| `getChannelForMessage(message)` | public | Channels from `Routing` (of an array route, only this connection's items), or the connection's default channel |
| `getDeadLetterChannelForMessage(message)` | public | Dead-letter channel from `Routing`, or `Options.defaultQueueDeadLetterChannel` |
| `__checkInstance__(options)` | public | `true` when `options[0].name` equals `Options.name`; used by `@PerInstanceCheck()` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Transport | `QueueClient`, many registrations, one per class; selected by class name from `queue.connections[].service`; lifetime from the class (`@PerInstanceCheck()` or `@NewInstance()`), or a factory registered under the class key (a new instance per resolve) | `BlackHoleQueueClient` (`@NewInstance()`), connection `black-hole` | `StompQueueClient` (`@spinajs/queue-stomp-transport`), `AmqpQueueClient` ([`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md)), `SqsQueueClient` ([`@spinajs/queue-sqs-transport`](../queue-sqs-transport/README.md)); each is `@PerInstanceCheck()` and has a factory that sets `clientId` to `<app.name>-<APP_ENV>-<name>` | Extend `QueueClient`, decorate `@Injectable(QueueClient)`, name the class in `service`. To extend a shipped transport, subclass it, decorate the subclass the same way and name the subclass. Change how a class is built with `DI.register(factory).as(TheClass)` |

`BlackHoleQueueClient` resolves every `emit()` and `subscribe()` at once and does nothing. Use it to drop messages a package emits that your app does not need.

### Transport: custom implementation

Implement `emit()`, both `subscribe()` overloads and both `unsubscribe()` overloads with one signature each (`string | Constructor<QueueMessage>`). Reuse `getChannelForMessage()` and `getDeadLetterChannelForMessage()` so routing config works the same as for the shipped transports. Register the class before `QueueService` is first resolved: import its module at startup.

This in-process transport delivers through memory: events go to every subscriber, a job to one subscriber in turn, failed jobs are retried `RetryCount` times with exponential backoff from `retryDelay`, then dead-lettered.

```ts sample
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { IQueueMessage, QueueClient, QueueMessage, QueueService, isJob } from '@spinajs/queue';

type Handler = (message: IQueueMessage) => Promise<void>;

interface DeadLetter {
  channel: string;
  message: IQueueMessage;
  error: string;
}

@PerInstanceCheck()
@Injectable(QueueClient)
export class InProcessQueueClient extends QueueClient {
  protected Subscribers = new Map<string, Handler[]>();
  protected NextJobHandler = new Map<string, number>();
  public DeadLetters: DeadLetter[] = [];

  public async emit(message: IQueueMessage): Promise<void> {
    for (const channel of this.getChannelForMessage(message)) {
      // a JSON copy behaves like a broker: the consumer never shares the producer's object
      const wire = JSON.parse(JSON.stringify(message)) as IQueueMessage;
      setImmediate(() => void this.dispatch(channel, wire, 1));
    }
  }

  public async subscribe(target: string | Constructor<QueueMessage>, callback: Handler): Promise<void> {
    for (const channel of this.channelsOf(target)) {
      this.Subscribers.set(channel, [...(this.Subscribers.get(channel) ?? []), callback]);
    }
  }

  public unsubscribe(target: string | Constructor<QueueMessage>): void {
    for (const channel of this.channelsOf(target)) {
      this.Subscribers.delete(channel);
    }
  }

  public async dispose(): Promise<void> {
    this.Subscribers.clear();
  }

  protected channelsOf(target: string | Constructor<QueueMessage>): string[] {
    return typeof target === 'string' ? [target] : this.getChannelForMessage(target);
  }

  protected async dispatch(channel: string, message: IQueueMessage, attempt: number): Promise<void> {
    const handlers = this.Subscribers.get(channel) ?? [];
    if (handlers.length === 0) {
      this.Log.warn({ channel }, 'No subscriber on ${channel}, message dropped');
      return;
    }

    const targets = isJob(message) ? [this.nextJobHandler(channel, handlers)] : handlers;
    for (const handler of targets) {
      try {
        await handler(message);
      } catch (err) {
        this.onFailure(channel, message, attempt, err);
      }
    }
  }

  protected nextJobHandler(channel: string, handlers: Handler[]): Handler {
    const index = (this.NextJobHandler.get(channel) ?? 0) % handlers.length;
    this.NextJobHandler.set(channel, index + 1);
    return handlers[index];
  }

  protected onFailure(channel: string, message: IQueueMessage, attempt: number, err: unknown) {
    if (isJob(message) && attempt <= (message.RetryCount ?? 0)) {
      const delay = (this.Options.retryDelay ?? 0) * 2 ** (attempt - 1);
      setTimeout(() => void this.dispatch(channel, message, attempt + 1), delay);
      return;
    }

    this.DeadLetters.push({ channel: this.getDeadLetterChannelForMessage(message) ?? channel, message, error: String(err) });
  }
}

// config/queue.ts
export const config = {
  queue: {
    default: 'in-process',
    connections: [
      {
        service: 'InProcessQueueClient',
        name: 'in-process',
        defaultQueueChannel: 'jobs',
        defaultTopicChannel: 'events',
        defaultQueueDeadLetterChannel: 'jobs-dlq',
        retryDelay: 200,
      },
    ],
  },
};

export async function deadLetters() {
  await DI.resolve(Configuration);
  const queue = await DI.resolve(QueueService);
  return (queue.get('in-process') as InProcessQueueClient).DeadLetters;
}
```

### Transport: extend a shipped one

Subclass the transport, register the subclass under `QueueClient`, and name the subclass in `service`. Overriding `getChannelForMessage()` changes channel naming for both publishing and subscribing.

```ts
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import { IQueueMessage, QueueClient, QueueMessage } from '@spinajs/queue';
import { StompQueueClient } from '@spinajs/queue-stomp-transport';

// One broker shared by staging and production: prefix every channel with the environment.
@PerInstanceCheck()
@Injectable(QueueClient)
export class EnvPrefixedStompClient extends StompQueueClient {
  public getChannelForMessage(message: IQueueMessage | Constructor<QueueMessage>): string[] {
    const env = process.env.APP_ENV ?? 'dev';
    return super.getChannelForMessage(message).map((channel) => channel.replace(/^\/(queue|topic)\//, `/$1/${env}.`));
  }
}

// queue.connections: [{ service: 'EnvPrefixedStompClient', name: 'broker', host: '...' }]
```

The factory a shipped transport registers is keyed by its own class, so it does not build your subclass: DI constructs the subclass and calls its `resolve()`, and `clientId` stays as configured. Register a factory under the subclass when you need the same setup; [Client factory](../queue-amqp-transport/06-client-factory.md) shows one.

## Important behaviour

- **Lifetime matters.** Without `@PerInstanceCheck()`, `@NewInstance()` or a factory, a transport is a singleton: a second connection using the same class gets the first connection's instance and the `Map` holds one key, so `emit()` to the second connection throws `ConnectionNotFound`.
- **`@NewInstance()` clients are not disposed by DI.** `DefaultQueueService.dispose()` disposes them; disposing only the container does not.
- **The class is found by its name.** A bundler that renames classes breaks `service`; keep class names in bundled builds.
- **The client receives the wire message, not the class.** `QueueService` filters by `Name`, so several message types can share one channel and one subscription.
- **A rejected handler is the only failure signal.** The queue has already recorded the failure in the job row; the transport decides whether the message comes back.
- **`emit()` resolving is the delivery guarantee.** Resolve before the broker confirms only for non-persistent events.

## Best practices

- Implement `resolve()` and `dispose()` for connect and close; DI calls `resolve()` when the queue builds the client.
- Honour `Persistent`, `Priority` and the `Schedule*` fields when the broker supports them, and log a warning when it does not.
- Use `getDeadLetterChannelForMessage()` for dead-lettering instead of reading `Options` yourself, so per-route `deadLetterChannel` works.
- Read rotating secrets through a [credential provider](05-credential-providers.md) instead of `login` and `password`.

## Related

- [Connections and routing](02-connections-and-routing.md): the config a transport receives.
- [Credential providers](05-credential-providers.md): credentials fetched before each connect.
- [Lifetimes](../di/04-lifetimes.md): `@PerInstanceCheck()` and `__checkInstance__`.
- [`@spinajs/queue-amqp-transport`](../queue-amqp-transport/README.md), [`@spinajs/queue-sqs-transport`](../queue-sqs-transport/README.md): shipped transports and their extension hooks.
