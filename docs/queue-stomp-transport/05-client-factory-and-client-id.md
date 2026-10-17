# Client factory and client id

Importing `@spinajs/queue-stomp-transport` registers a factory under the `StompQueueClient` key. Every connection entry with `service: 'StompQueueClient'` is built by it: the factory derives the STOMP `client-id` from the app name, the environment and the connection name, then connects. Replace the factory to change how client ids are made or how clients are built.

## How it works

1. `connection-factory.ts` runs `DI.register(async (container, options) => { ... }).as(StompQueueClient)` when the package is imported.
2. `@AutoinjectService('queue.connections', QueueClient)` matches `service: 'StompQueueClient'` to the class, then resolves the `StompQueueClient` key with the entry as options. The factory is the last registration under that key, so DI calls it instead of the constructor. `DI.resolve(StompQueueClient, [entry])` does the same.
3. The factory reads `Configuration` with `container.get(Configuration)` from the resolving container. No resolved `Configuration` throws `InvalidOperation('Configuration service is not available, cannot resolve STOMP queue connection')`.
4. It builds the client id `<app.name>-<APP_ENV>-<entry.name>`:
   - `app.name` defaults to `'no-app'` here; `@spinajs/configuration`'s own config sets it to `'spinajs'`;
   - `APP_ENV` is the config value `process.env.APP_ENV`, which `Configuration` fills from `--env`, the `APP_ENV` variable, `NODE_ENV`, or `'development'`, and defaults to `'development'` here.
5. It calls `new StompQueueClient({ ...entry, clientId })`, so an entry's own `clientId` is overwritten.
6. It awaits `client.resolve()`, the first connect, and returns the client. A failed connect rejects the factory and with it the boot.

With the defaults, a connection named `activemq` in an app with `app.name: 'orders'` running with `APP_ENV=production` connects as `orders-production-activemq`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `app.name` | `string` | `'spinajs'` (from `@spinajs/configuration`), `'no-app'` when unset | | First part of the client id. |
| `process.env.APP_ENV` | `string` | `--env`, `APP_ENV`, `NODE_ENV`, else `'development'` | | Second part of the client id. |
| `queue.connections[].name` | `string` | none, required | | Last part of the client id. |
| `queue.connections[].clientId` | `string` | `undefined` | | Ignored by the shipped factory; used by a custom factory or a subclass built without one. |

```ts
// config/app.ts
export default {
  app: { name: 'orders' },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Client factory | the `StompQueueClient` key; a factory: called on every resolve, never cached, never disposed by the container | `<app.name>-<APP_ENV>-<name>`, `new StompQueueClient()`, `resolve()` | your factory | `DI.register(yourFactory).as(StompQueueClient)` **after** importing the package and before `QueueService` resolves; the last registration wins |
| Factory for a subclass | the subclass key | none: DI builds a subclass with its constructor and calls `resolve()`; its client id is `clientId ?? name` | your factory | `DI.register(factory).as(MySubclass)` |

### Client factory: custom implementation

Several replicas of one app, with the shipped factory, all connect with the same client id. A broker that enforces unique client ids, as ActiveMQ does, refuses every replica but the first. This factory honours an explicit `clientId` from the entry and otherwise adds the host name and process id.

```ts sample
import '@spinajs/queue-stomp-transport';
import { hostname } from 'os';
import { DI, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { IQueueConnectionOptions } from '@spinajs/queue';
import { StompQueueClient } from '@spinajs/queue-stomp-transport';

// registered after the package import above, so it replaces the shipped factory
DI.register(async (container: IContainer, options: IQueueConnectionOptions) => {
  const cfg = container.get(Configuration);
  if (!cfg) {
    throw new InvalidOperation('Configuration is not resolved, cannot build a STOMP connection');
  }

  const app = cfg.get<string>('app.name', 'no-app');
  const env = cfg.get<string>('process.env.APP_ENV', 'development');
  const clientId = options.clientId ?? `${app}-${env}-${options.name}-${hostname()}-${process.pid}`;

  const client = new StompQueueClient({ ...options, clientId });
  await client.resolve();
  return client;
}).as(StompQueueClient);
```

A per-replica client id changes durable subscriptions: ActiveMQ keys them by client id plus subscription name, so each replica gets its own durable subscription and its own copy of every topic message, and a replaced pod leaves its subscription behind. Keep durable topic consumers on a connection with a stable `clientId`, or consume jobs from `/queue/...` channels, which do not depend on the client id.

### Factory for a subclass

A subclass selected by its own class name skips the shipped factory: its client id is `clientId ?? name`, without the app and environment. Register a factory under the subclass key to keep the prefixed id.

```ts sample
import '@spinajs/queue-stomp-transport';
import { DI, IContainer, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { IQueueConnectionOptions, QueueClient } from '@spinajs/queue';
import { StompQueueClient } from '@spinajs/queue-stomp-transport';

@PerInstanceCheck()
@Injectable(QueueClient)
export class AuditedStompClient extends StompQueueClient {
  public async resolve() {
    this.Log.info({ connection: this.Options.name, clientId: this.ClientId }, 'Opening audited STOMP connection ${connection} as ${clientId}');
    await super.resolve();
  }
}

DI.register(async (container: IContainer, options: IQueueConnectionOptions) => {
  const cfg = container.get(Configuration);
  const app = cfg?.get<string>('app.name', 'no-app') ?? 'no-app';
  const env = cfg?.get<string>('process.env.APP_ENV', 'development') ?? 'development';

  // `new`, not container.resolve(AuditedStompClient): that would call this factory again
  const client = new AuditedStompClient({ ...options, clientId: `${app}-${env}-${options.name}` });
  await client.resolve();
  return client;
}).as(AuditedStompClient);

// config/queue.ts
export const config = {
  queue: {
    default: 'activemq',
    connections: [{ service: 'AuditedStompClient', name: 'activemq', host: 'ws://activemq:61614/ws' }],
  },
};
```

## Important behaviour

- The factory bypasses the `@PerInstanceCheck()` cache: every resolve of the `StompQueueClient` key builds and connects a new client. `QueueService` resolves each entry once at boot and keeps the clients; get them with `QueueService.get(name)`.
- Factory results are not tracked by the container. `DefaultQueueService.dispose()` disposes them; a client you resolve yourself is yours to dispose.
- Two processes with the same `app.name`, `APP_ENV` and connection `name` get the same client id. Use a [custom factory](#client-factory-custom-implementation) or a per-process `clientId` when you run replicas.
- The factory is registered at import time. A replacement registered before the package is imported is overridden by the shipped one.
- A factory that resolves the class it is registered for through the container recurses into itself. Build the client with `new`.
- A client built with `new` gets no constructor or property injection from DI. `StompQueueClient` reads its logger and `queue.routing` through lazy getters, so it works; `@Autoinject` properties of a subclass stay empty.

## Best practices

- Set `app.name` in every app that uses this transport, so client ids in the broker console name the app, not `spinajs`.
- Set `APP_ENV` (or `--env`) per deployment, so staging and production sharing a broker do not collide.
- Keep the replacement factory in the module that boots your app, right after the package import, so the order is explicit.

## Patterns and antipatterns

```ts
// Don't: resolve through the container inside the factory; DI calls this factory again, forever
DI.register((c: IContainer, options: IQueueConnectionOptions) => c.resolve(StompQueueClient, [options])).as(StompQueueClient);

// Do: build with new, then connect
DI.register(async (_c: IContainer, options: IQueueConnectionOptions) => {
  const client = new StompQueueClient(options);
  await client.resolve();
  return client;
}).as(StompQueueClient);
```

## Related

- [STOMP connection](01-stomp-connection.md): step 2 of the boot flow is this factory.
- [Consuming, retries and dead letters](03-consuming-retries-and-dead-letters.md#important-behaviour): durable subscriptions and the client id.
- [Extending the STOMP client](06-extending-the-stomp-client.md): subclasses that need their own factory.
- [`@spinajs/di`](../di/08-factories.md): how factories are called and why they are never cached.
- [`@spinajs/configuration`](../configuration/README.md): `app.name` and `process.env.APP_ENV`.
