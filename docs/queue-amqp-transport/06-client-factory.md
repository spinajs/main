# Client factory

Importing the package registers a factory function under the `AmqpQueueClient` key. Every resolve of `AmqpQueueClient`, including each `service: 'AmqpQueueClient'` connection entry, goes through it. Unless the entry sets `clientId`, it names the broker connection `<app.name>-<APP_ENV>-<name>`, so several apps can share one connection config and still show up apart in the broker.

## How it works

1. `src/connection-factory.ts` runs `DI.register(factory).as(AmqpQueueClient)` on import. It is the last registration under that key, after the class's own.
2. `DI.resolve(AmqpQueueClient, [entry])`, direct or through `@AutoinjectService`, calls `factory(container, entry)`.
3. The factory reads `app.name` (default `no-app`) and `process.env.APP_ENV` (default `development`) from the container's `Configuration`.
4. It calls `new AmqpQueueClient({ ...entry, clientId: entry.clientId ?? '<app.name>-<APP_ENV>-<entry.name>' })`. A `clientId` in the entry is kept.
5. It awaits `client.resolve()`, which connects; see [AMQP connection](01-amqp-connection.md). A connect error rejects the resolve.
6. It returns the connected client. `ClientId` is sent to the broker as the `connection_name` client property.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `app.name` | `string` | `no-app` | | First part of the broker connection name. |
| `process.env.APP_ENV` | `string` | `development` | | Second part; the configuration exposes the environment variable `APP_ENV` here. |
| `queue.connections[].name` | `string` | none, required | | Last part. |
| `queue.connections[].clientId` | `string` | none | | When set, used as the broker connection name instead. |

```ts
// config/app.ts
export default {
  app: { name: 'billing-api' },
};
// APP_ENV=production gives the broker connection name "billing-api-production-rabbit"
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Client factory | key `AmqpQueueClient`; factory, a new instance on every resolve | defaults `clientId`, constructs, connects | your factory, a subclass registered under the key | `DI.register(myFactory).as(AmqpQueueClient)`; the last registration wins |
| Subclass factory | key of your subclass | none; DI constructs the subclass and calls `resolve()` | a factory like the one below | `DI.register(myFactory).as(MySubclass)` |

### Client factory: custom implementation

Replace the factory to change the broker connection name or to fill in options at resolve time. The sample names connections after the Kubernetes pod and builds the subclass from [Extending the AMQP client](05-extending-the-amqp-client.md), so the subclass keeps a factory too.

```ts sample
import '@spinajs/queue-amqp-transport';
import { Configuration } from '@spinajs/configuration';
import { DI, IContainer, Injectable, NewInstance } from '@spinajs/di';
import { IQueueConnectionOptions, QueueClient } from '@spinajs/queue';
import { AmqpQueueClient } from '@spinajs/queue-amqp-transport';

@NewInstance()
@Injectable(QueueClient)
export class PodAmqpQueueClient extends AmqpQueueClient {}

async function podClientFactory(container: IContainer, options: IQueueConnectionOptions) {
  const cfg = container.get(Configuration)!;
  const appName = cfg.get<string>('app.name', 'no-app');
  const pod = process.env.HOSTNAME ?? 'local';

  const client = new PodAmqpQueueClient({ ...options, clientId: `${appName}-${pod}-${options.name}` });
  await client.resolve();

  return client;
}

// service: 'AmqpQueueClient' entries
DI.register(podClientFactory).as(AmqpQueueClient);

// service: 'PodAmqpQueueClient' entries
DI.register(podClientFactory).as(PodAmqpQueueClient);
```

## Important behaviour

- Factories are never cached. Every `DI.resolve(AmqpQueueClient, [entry])` opens a new broker connection, even for the same `name`; `@PerInstanceCheck()` on the class does not apply. Keep the instance you get.
- `QueueService` resolves each entry once, so this matters only for direct `DI.resolve()` calls.
- The factory constructs the client with `new`, so DI injects nothing into the instance. `Log` and `Routing` still work: the `@Logger()` and `@Config()` getters fall back to the root container.
- A `clientId` in config wins over the generated name. Two clients with the same `clientId` show up under one name in the broker.
- Two processes with the same `app.name`, `APP_ENV` and connection `name` get the same connection name in the broker. RabbitMQ accepts that; they are only harder to tell apart.

## Best practices

- Set `app.name` per service. With the default `no-app`, every service shows up as `no-app-<env>-<name>` in the broker.
- When you replace the factory, keep the `await client.resolve()`; DI does not call `resolve()` on what a factory returns.

## Patterns and antipatterns

```ts
// Don't: a new broker connection on every call
export async function publishAudit(message: IQueueMessage) {
  const client = await DI.resolve(AmqpQueueClient, [auditConnection]);
  await client.emit(message);
}

// Do: resolve once and reuse, or go through QueueService
const auditClient = DI.resolve(AmqpQueueClient, [auditConnection]);
export async function publishAudit(message: IQueueMessage) {
  await (await auditClient).emit(message);
}
```

## Related

- [AMQP connection](01-amqp-connection.md): what `resolve()` does after the factory.
- [Extending the AMQP client](05-extending-the-amqp-client.md): subclasses and the `QueueClient` registration.
- [`@spinajs/di`](../di/08-factories.md): factory registration and why factories are not cached.
- [`@spinajs/configuration`](../configuration/README.md): `app.name` and `process.env.APP_ENV`.
