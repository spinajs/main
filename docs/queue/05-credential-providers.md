# Credential providers

An `IQueueCredentialsProvider` hands a transport its broker login right before each connect and reconnect. Use it for rotating secrets and short-lived tokens, instead of a fixed `login` and `password` in `queue.connections`.

`@spinajs/queue` only declares the contract; the transport calls it. `StompQueueClient` (`@spinajs/queue-stomp-transport`) does. `AmqpQueueClient` and `SqsQueueClient` do **not** read `credentialProvider`.

## How it works

In `StompQueueClient`:

1. When the connection entry has `credentialProvider`, the client installs a `beforeConnect` callback on the STOMP client.
2. Before every connect and reconnect, the callback runs `DI.resolve<IQueueCredentialsProvider>(credentialProvider)`.
3. It awaits `provider.getCredentials(options)`, where `options` is the connection entry.
4. It sends `login` and `passcode` from the result as STOMP connect headers, with `client-id`. A missing field is left out.
5. An unregistered name or an error from `getCredentials()` rejects `beforeConnect`, and that connect attempt fails. <!-- TODO(docs-hook): verify whether the STOMP client then retries after `reconnectDelay` or stops -->

## API

| Export | Kind | Meaning |
| --- | --- | --- |
| `IQueueCredentialsProvider` | interface | `getCredentials(options: IQueueConnectionOptions): Promise<{ login?: string; passcode?: string }>` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.connections[].credentialProvider` | `string` | unset | a DI registration name | Provider to ask before each connect. Its `login` and `passcode` replace the configured `login` and `password` |

```ts
// config/queue.ts
export default {
  queue: {
    connections: [{ service: 'StompQueueClient', name: 'broker', host: 'wss://mq.example.com/ws', credentialProvider: 'brokerCredentials' }],
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Credentials provider | A string name, from `queue.connections[].credentialProvider`; resolved on every connect with `DI.resolve(name)`; lifetime from the registration (a class is a singleton) | none | none shipped | `DI.register(MyProvider).as('<name>')`, or a factory with `DI.register(fn).as('<name>')` |

### Credentials provider: custom implementation

Register the provider under the name you put in `credentialProvider`, before the transport first connects (import it at startup, before `QueueService` is resolved). Use the `options` argument to serve several connections from one provider.

This provider reads a token that a sidecar rotates in a mounted file, so a rotated token is picked up on the next reconnect without a restart.

```ts sample
import { readFile } from 'node:fs/promises';
import { DI } from '@spinajs/di';
import { IQueueConnectionOptions, IQueueCredentialsProvider } from '@spinajs/queue';

export class MountedSecretCredentials implements IQueueCredentialsProvider {
  public async getCredentials(options: IQueueConnectionOptions) {
    const dir = process.env.BROKER_SECRETS_DIR ?? '/var/run/secrets/broker';
    const passcode = (await readFile(`${dir}/${options.name}.token`, 'utf8')).trim();

    return { login: options.login ?? 'app', passcode };
  }
}

DI.register(MountedSecretCredentials).as('brokerCredentials');

// config/queue.ts
export const config = {
  queue: {
    default: 'broker',
    connections: [
      {
        service: 'StompQueueClient',
        name: 'broker',
        host: 'wss://mq.example.com/ws',
        login: 'billing-api',
        credentialProvider: 'brokerCredentials',
      },
    ],
  },
};
```

## Important behaviour

- **The provider runs on every reconnect**, so keep it fast and let it cache when the secret store is slow.
- **A singleton provider is shared** by every connection that names it; key any state by `options.name`.
- **The name is resolved at connect time**, not at boot: a typo in `credentialProvider` shows up only when the transport connects.

## Best practices

- Leave `password` out of the entry when a provider supplies it, so no stale secret sits in config.
- Read short-lived tokens with an expiry check and fetch a new one only when the cached one is close to expiry.

## Related

- [Transports](04-transports.md): who calls the provider.
- [Connections and routing](02-connections-and-routing.md): the connection entry the provider receives.
- [Named services](../di/07-named-services.md): registering a service under a string name.
