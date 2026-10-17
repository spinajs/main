# AMQP connection

Each `queue.connections` entry with `service: 'AmqpQueueClient'` becomes one `AmqpQueueClient`, holding one amqplib connection and two channels. This page covers the connection config, how the connect target is built, TLS and socket options, reconnects and shutdown.

## How it works

1. **Selection.** `DefaultQueueService` (`@spinajs/queue`) injects `queue.connections` with `@AutoinjectService('queue.connections', QueueClient)`. For each entry DI finds the `QueueClient` registration whose class name equals `service`, here `AmqpQueueClient`.
2. **Factory.** DI resolves `AmqpQueueClient` with the entry as the option. The [client factory](06-client-factory.md) runs: it sets `clientId` to `<app.name>-<APP_ENV>-<name>`, calls `new AmqpQueueClient(...)`, then `resolve()`.
3. **Target.** `connect()` clears the per-connection assert caches and calls `buildConnectionTarget()`, which turns `host`, `port`, `login`, `password` and the vhost into an amqplib `Options.Connect` object. See [Connect target](#connect-target).
4. **Connect.** `createConnection(target, socketOptions)` calls `amqp.connect()`. `socketOptions` is `{ clientProperties: { connection_name: ClientId }, ...options }`. Any failure becomes `UnexpectedServerError('Cannot connect to AMQP queue server at <host>')`.
5. **Listeners.** The client logs connection `error` events and calls `onConnectionLost()` on `close`.
6. **Channels.** It opens a confirm channel for publishing (`PublishChannel`) and a plain channel for consuming (`ConsumeChannel`), then sets `prefetch(options.prefetch ?? 1)` on the consume channel.
7. **Ready.** `IsConnected` turns `true`. `replaySubscriptions()` restarts every known consumer and `flushPendingEmits()` publishes messages buffered while disconnected.
8. **Store.** `DefaultQueueService` keeps the client in its `Connections` map under the entry `name`.

The first connect has no retry. When it fails, `resolve()` rejects and `QueueService` does not resolve.

```mermaid
sequenceDiagram
  participant QS as DefaultQueueService
  participant DI
  participant F as client factory
  participant C as AmqpQueueClient
  participant B as RabbitMQ
  QS->>DI: @AutoinjectService('queue.connections', QueueClient)
  DI->>DI: entry.service === 'AmqpQueueClient'
  DI->>F: factory(container, entry)
  F->>C: new AmqpQueueClient({ ...entry, clientId })
  F->>C: resolve()
  C->>C: buildConnectionTarget()
  C->>B: createConnection(target, socketOptions)
  C->>B: createConfirmChannel(), createChannel(), prefetch(n)
  C->>C: replaySubscriptions(), flushPendingEmits()
  F-->>QS: client, stored under entry.name
```

### Reconnect

1. The broker or network closes the connection; amqplib emits `close`.
2. `onConnectionLost()` sets `IsConnected` to `false` and calls `scheduleReconnect()`. It does nothing while disposing or when already disconnected.
3. `scheduleReconnect()` arms one timer of `reconnectDelay` ms (default `5000`).
4. The timer calls `connect()`. On failure it logs the error and arms the timer again, with the same delay, without limit.
5. On success, consumers are recreated and buffered emits are published.

### Dispose

`dispose()` sets the disposing flag, clears the reconnect timer, closes both channels and the connection (errors are logged as warnings), sets `IsConnected` to `false` and forgets all subscriptions. `DefaultQueueService.dispose()` calls it for every connection.

## Connect target

`buildConnectionTarget()` always passes an object to amqplib, never a URL string, so `login` and `password` apply to a URL host too.

| `host` value | `protocol` | `hostname` | `port` | `username` / `password` | `vhost` | Tuning |
| --- | --- | --- | --- | --- | --- | --- |
| unset | `amqp` | `localhost` | `port ?? 5672` | `login` / `password` | `options.vhost ?? '/'` | none |
| plain name, eg. `rabbitmq.internal` | `amqp` | the value | `port ?? 5672` | `login` / `password` | `options.vhost ?? '/'` | none |
| URL, eg. `amqps://user:pass@broker:5671/prod?heartbeat=30` | URL scheme | URL host, IPv6 brackets removed | URL port, else `port`, else `5671` for `amqps` and `5672` otherwise | URL credentials, URL-decoded, when the URL has either; else `login` / `password` | URL path without the leading `/`, kept percent-encoded; `/` when empty | `heartbeat`, `frameMax`, `locale` from the query string |
| value with `://` that `new URL()` rejects | `amqp` | the whole value | `port ?? 5672` | `login` / `password` | `options.vhost ?? '/'` | none |

When neither `username` nor `password` reaches amqplib, amqplib logs in as `guest` / `guest`.

## Configuration

Keys of one entry in `queue.connections`. Keys not listed here (`queue`, `credentialProvider`, `heartbeatIncoming`, `heartbeatOutgoing`, `connectionTimeout`, `debug`) are ignored by this transport.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.connections[].service` | `string` | none, required | `AmqpQueueClient` or the class name of a subclass | Selects the transport class. |
| `queue.connections[].name` | `string` | none, required | unique per app | Connection name used by `queue.default`, routing `connection` and `QueueService.get()`. Also the last part of the broker connection name. |
| `queue.connections[].host` | `string` | `localhost` | host name, or `amqp://` / `amqps://` URL | Broker address; see [Connect target](#connect-target). |
| `queue.connections[].port` | `number` | `5672` (`5671` for an `amqps` URL) | TCP port | Used when the `host` URL has no port, or `host` is not a URL. |
| `queue.connections[].login` | `string` | none (amqplib uses `guest`) | | User name, unless the `host` URL carries credentials. |
| `queue.connections[].password` | `string` | none (amqplib uses `guest`) | | Password, unless the `host` URL carries credentials. |
| `queue.connections[].clientId` | `string` | `<app.name>-<APP_ENV>-<name>` | | Overwritten by the [client factory](06-client-factory.md); a configured value applies only to subclasses resolved without it. |
| `queue.connections[].reconnectDelay` | `number` (ms) | `5000` | `>= 0` | Fixed delay before each reconnect attempt. |
| `queue.connections[].transport` | `string` | none | any | Required by the `IQueueConnectionOptions` type, unused at runtime. |
| `queue.connections[].type` | `'event' \| 'job'` | none | | Required by the type, unused by this transport. |
| `queue.connections[].options` | `object` | `{}` | | Spread into the amqplib socket options; also holds the transport keys below. |
| `queue.connections[].options.vhost` | `string` | `/` | vhost name | Virtual host when `host` is not a URL. Ignored for a URL host. |
| `queue.connections[].options.ca`, `.cert`, `.key`, `.passphrase`, `.servername`, `.rejectUnauthorized` | Node TLS options | | | Passed to `tls.connect()` for an `amqps` URL. |
| `queue.connections[].options.timeout` | `number` (ms) | none | | Socket connect timeout, applied by amqplib. |
| `queue.connections[].options.noDelay`, `.keepAlive`, `.keepAliveDelay` | `boolean` / `number` | `false` / `false` / `0` | | TCP socket settings, applied by amqplib. |
| `queue.connections[].options.credentials` | amqplib credentials | `PLAIN` from username / password | `credentials.external()`, `credentials.amqplain(...)` | SASL mechanism; overrides `login` / `password`. Use `external()` for client-certificate login. |
| `queue.connections[].options.clientProperties` | `object` | `{ connection_name: ClientId }` | | Replaces the whole default, so set `connection_name` yourself when you set this. |

Transport keys read from `options` (prefetch, topic prefix, emit retries) are on [Channel topology](02-channel-topology.md#configuration) and [Publishing](03-publishing.md#configuration).

```ts
// config/queue.ts
export default {
  queue: {
    default: 'rabbit',
    connections: [
      {
        service: 'AmqpQueueClient',
        name: 'rabbit',
        host: 'amqps://rabbitmq.internal:5671/billing?heartbeat=30',
        login: 'billing',
        password: process.env.RABBIT_PASSWORD,
        reconnectDelay: 2000,
        defaultTopicChannel: '/topic/default',
        defaultQueueChannel: '/queue/default',
        options: {
          ca: [process.env.RABBIT_CA_PEM],
          servername: 'rabbitmq.internal',
        },
      },
    ],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Socket connection | `protected createConnection(url, socketOptions): Promise<ChannelModel>` | `amqp.connect(url, socketOptions)` | a fake connection in tests, failover over several nodes | Override in a subclass |
| Connect target | `protected buildConnectionTarget(): Options.Connect` | the table in [Connect target](#connect-target) | | Override; call `super.buildConnectionTarget()` and change fields |
| Target from discrete fields | `protected connectOptionsFromFields(hostname): Options.Connect` | `protocol`, `hostname`, `port`, `username`, `password`, `vhost` | | Override to add `heartbeat`, `frameMax` or a secret lookup |
| Reconnect delay | `protected get ReconnectDelay(): number` | `reconnectDelay ?? 5000` | | Override the getter |
| Reconnect policy | `protected onConnectionLost()`, `protected scheduleReconnect()` | fixed-delay retry forever | | Override, eg. to stop after N attempts or add backoff |
| Connect sequence | `protected connect()` | steps 3 to 7 above | | Override and call `super.connect()`, eg. to declare extra topology after each (re)connect |

### Socket connection: custom implementation

Override `createConnection()` to change how the socket is opened. The sample connects to the first reachable node of a RabbitMQ cluster, read from a custom `options.nodes` key, and adds a heartbeat to the discrete-fields target (which has none by default).

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { QueueClient } from '@spinajs/queue';
import { AmqpQueueClient } from '@spinajs/queue-amqp-transport';
import { connect, ChannelModel, Options } from 'amqplib';

@NewInstance()
@Injectable(QueueClient)
export class ClusterAmqpQueueClient extends AmqpQueueClient {
  protected connectOptionsFromFields(hostname: string): Options.Connect {
    return {
      ...super.connectOptionsFromFields(hostname),
      heartbeat: (this.Options.options?.heartbeat as number | undefined) ?? 30,
    };
  }

  protected async createConnection(target: string | Options.Connect, socketOptions: Record<string, unknown>): Promise<ChannelModel> {
    const nodes: string[] = this.Options.options?.nodes ?? [];
    if (typeof target === 'string' || nodes.length === 0) {
      return super.createConnection(target, socketOptions);
    }

    let lastError: unknown;
    for (const hostname of nodes) {
      try {
        return await connect({ ...target, hostname }, { ...socketOptions, servername: hostname });
      } catch (err) {
        lastError = err;
        this.Log.warn({ node: hostname }, 'RabbitMQ node ${node} is not reachable, trying the next one');
      }
    }

    throw lastError;
  }
}

// config/queue.ts
export const config = {
  queue: {
    default: 'rabbit',
    connections: [
      {
        service: 'ClusterAmqpQueueClient',
        name: 'rabbit',
        login: 'orders',
        password: process.env.RABBIT_PASSWORD,
        defaultTopicChannel: '/topic/default',
        defaultQueueChannel: '/queue/default',
        options: {
          nodes: ['rabbit-1.internal', 'rabbit-2.internal', 'rabbit-3.internal'],
          heartbeat: 15,
        },
      },
    ],
  },
};
```

Import the module that declares the class before `QueueService` resolves; see [Extending the AMQP client](05-extending-the-amqp-client.md).

## Important behaviour

- `options.heartbeat` set as a plain option does **not** reach amqplib: the connect target is an object, and amqplib reads the heartbeat only from that object. Put `?heartbeat=<seconds>` in a URL `host`, or override `connectOptionsFromFields()` as above. Without either, heartbeats are off.
- Credentials embedded in a URL `host` win over `login` and `password`, even when only one of user or password is in the URL.
- For a URL `host`, the vhost comes from the URL path. `options.vhost` is ignored.
- TLS needs an `amqps://` URL `host`. A plain host name always connects with `protocol: 'amqp'`, so TLS options under `options` have no effect there.
- The whole `options` object is also passed as amqplib socket options, transport keys such as `prefetch` included. Node ignores the keys it does not know.
- The first connect fails fast; only later drops are retried. Start the broker before the app, or catch the boot error.
- The reconnect delay is fixed. Many apps restarting against one broker reconnect in step; override `scheduleReconnect()` to spread them.
- Only the connection has `error` and `close` listeners. A channel closed by the broker (eg. `PRECONDITION_FAILED` when a queue is re-declared with other arguments) emits `error` on a channel with no listener, and that channel is not reopened.
- After `dispose()` the client does not reconnect and cannot be reused; resolve a new one.

## Best practices

- Use an `amqps://` URL with `options.ca` in production; a plain `amqp://` host sends credentials in clear text.
- Give each app a distinct `app.name`. The broker management UI then shows `<app>-<env>-<connection>` for each connection.
- Set `?heartbeat=` in the `host` URL so dead TCP connections are detected and the reconnect starts.
- Keep secrets out of the `host` URL when the URL is logged: the connect log prints `host` as configured. Use `login` and `password` instead.

## Patterns and antipatterns

```ts
// Don't: the heartbeat is passed as a socket option and never negotiated
{ service: 'AmqpQueueClient', name: 'rabbit', host: 'rabbitmq.internal', options: { heartbeat: 30 } }

// Do: put it in the URL query, where the connect target picks it up
{ service: 'AmqpQueueClient', name: 'rabbit', host: 'amqp://rabbitmq.internal?heartbeat=30', login: 'app', password: process.env.RABBIT_PASSWORD }
```

```ts
// Don't: credentials in the URL end up in the "Connecting to AMQP queue at ..." log line
{ service: 'AmqpQueueClient', name: 'rabbit', host: 'amqp://app:s3cret@rabbitmq.internal' }

// Do: keep the URL free of secrets
{ service: 'AmqpQueueClient', name: 'rabbit', host: 'amqp://rabbitmq.internal', login: 'app', password: process.env.RABBIT_PASSWORD }
```

## Examples

### Log in with a client certificate

```ts sample
import { readFileSync } from 'node:fs';
import { credentials } from 'amqplib';

// config/queue.ts
export const config = {
  queue: {
    default: 'rabbit',
    connections: [
      {
        service: 'AmqpQueueClient',
        name: 'rabbit',
        host: 'amqps://rabbitmq.internal:5671/payments',
        defaultTopicChannel: '/topic/default',
        defaultQueueChannel: '/queue/default',
        options: {
          ca: [readFileSync('/etc/rabbitmq/ca.pem')],
          cert: readFileSync('/etc/payments/client.pem'),
          key: readFileSync('/etc/payments/client.key'),
          credentials: credentials.external(),
        },
      },
    ],
  },
};
```

### Use a client without `QueueService`

`DI.resolve(AmqpQueueClient, [entry])` runs the factory and returns a connected client. Use it for raw channels, eg. a monitoring tool. Every call creates a new connection; keep the instance.

```ts sample
import '@spinajs/queue-amqp-transport';
import { DI } from '@spinajs/di';
import { IQueueMessage } from '@spinajs/queue';
import { AmqpQueueClient } from '@spinajs/queue-amqp-transport';

export async function watchAuditTrail() {
  const client = await DI.resolve(AmqpQueueClient, [
    {
      name: 'audit-watcher',
      host: 'amqp://rabbitmq.internal',
      login: 'monitor',
      password: process.env.RABBIT_PASSWORD,
      defaultTopicChannel: '/topic/default',
      defaultQueueChannel: '/queue/default',
    },
  ]);

  await client.subscribe('/topic/audit', async (message: IQueueMessage) => {
    console.log(`${message.Name} at ${String(message.CreatedAt)}`);
  });

  return client;
}
```

## Related

- [Client factory](06-client-factory.md): how the broker connection name is set and why each resolve opens a new connection.
- [Channel topology](02-channel-topology.md): what the client declares once connected.
- [Extending the AMQP client](05-extending-the-amqp-client.md): registering and selecting a subclass.
- [`@spinajs/queue`](../queue/README.md): `queue.connections`, `queue.default` and `QueueService`.
