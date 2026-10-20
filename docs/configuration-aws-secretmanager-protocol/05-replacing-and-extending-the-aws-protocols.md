# Replacing and extending the AWS protocols

Both protocols are plain DI singletons registered under `ConfigVarProtocol`. Subclass one to change how it builds its client, rewrites ids or shapes values, then take the original out of DI.

## How it works

1. Importing `@spinajs/configuration-aws-secretmanager-protocol` evaluates `@Injectable(ConfigVarProtocol)` on both classes. Each is appended to the `ConfigVarProtocol` list and registered as itself.
2. Your subclass, decorated the same way, is appended when its module is evaluated, after the import.
3. `DI.unregister(AwsSecretsManagerVarProtocol)` removes the original from the `ConfigVarProtocol` list and from its own key.
4. `FrameworkConfiguration.loadProtocolVars()` resolves `Array.ofType(ConfigVarProtocol)` and builds a `Map` from `Protocol` to instance. Your subclass inherits `Protocol`, so it serves `aws-secrets://`.
5. Every registration and unregistration must happen before `Configuration` is resolved; `resolve()` runs `load()`, which runs the protocols.

Without step 3 both classes claim `aws-secrets://` and the later entry in the list wins the `Map`. That works today because of import order, but it also instantiates the unused original.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AwsSecretsManagerVarProtocol` | `ConfigVarProtocol` list entry and self; `@Singleton()`; decorators at import | itself | none shipped | Subclass + `@Injectable(ConfigVarProtocol)` + `DI.unregister(AwsSecretsManagerVarProtocol)` |
| `AwsParameterStoreVarProtocol` | `ConfigVarProtocol` list entry and self; `@Singleton()`; decorators at import | itself | none shipped | Subclass + `@Injectable(ConfigVarProtocol)` + `DI.unregister(AwsParameterStoreVarProtocol)` |

Members meant for subclasses:

| Member | Class | Override to |
| --- | --- | --- |
| `get Protocol(): string` | both | Serve another scheme, e.g. a second account under `aws-secrets-shared://`. Must match `[a-zA-Z0-9-]+://`. |
| `getVar(path, configuration)` | both | Rewrite the path before `super.getVar()`, or post-process its result. |
| `protected Client` | both | Assign your own `SecretsManagerClient` / `SSMClient` before the first `getVar()`; it is then used as is and `aws.*` client options are ignored. |
| `protected cache` | both | Swap the `TtlCache` (clock, isolation). See [Caching](04-caching.md). |
| `protected fetchTree(path, withDecryption)` | `AwsParameterStoreVarProtocol` | Filter or convert the nested object of a `/*` read. |
| `clearCache()` | both | Also reset state your subclass adds. |
| `resolve()` / `dispose()` | both, from `AsyncService` | Set up the client asynchronously, or destroy it on shutdown. The shipped classes do not destroy their client. |

### Secrets Manager: secret ids scoped by environment

Prefix every id with `APP_ENV`, so the same config file reads `prod/db/credentials` in production and `staging/db/credentials` in staging. ARNs would break under a prefix, so they pass through.

```ts sample
import { AwsSecretsManagerVarProtocol } from '@spinajs/configuration-aws-secretmanager-protocol';
import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';

@Singleton()
@Injectable(ConfigVarProtocol)
export class EnvScopedSecretsProtocol extends AwsSecretsManagerVarProtocol {
  public async getVar(path: string, configuration: any) {
    if (path.startsWith('arn:')) {
      return super.getVar(path, configuration);
    }

    // FrameworkConfiguration.load() puts process.env, with APP_ENV, into the raw config
    const env: string = configuration?.process?.env?.APP_ENV ?? 'development';
    return super.getVar(`${env}/${path}`, configuration);
  }
}

DI.unregister(AwsSecretsManagerVarProtocol);

// with APP_ENV=production, 'aws-secrets://db/credentials#password' reads 'production/db/credentials'
```

### Secrets Manager: your own client and a second account

Build the client yourself to use options the config cannot express, and serve a second scheme for a shared account. This class is added next to the default protocol, so nothing is unregistered.

```ts sample
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AwsSecretsManagerVarProtocol } from '@spinajs/configuration-aws-secretmanager-protocol';
import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { Injectable, Singleton } from '@spinajs/di';

@Singleton()
@Injectable(ConfigVarProtocol)
export class SharedAccountSecretsProtocol extends AwsSecretsManagerVarProtocol {
  constructor() {
    super();
    this.Client = new SecretsManagerClient({
      region: 'eu-west-1',
      maxAttempts: 8,
      endpoint: process.env.SHARED_SECRETS_ENDPOINT,
    });
  }

  get Protocol(): string {
    return 'aws-secrets-shared://';
  }

  public async dispose(): Promise<void> {
    this.Client.destroy();
  }
}

// config: licenseKey: 'aws-secrets-shared://licensing/product-key'
```

### Parameter Store: typed hierarchy values

`fetchTree()` returns strings. Override it to turn `'5432'` into `5432` and `'true'` into `true` for every `/*` read.

```ts sample
import { AwsParameterStoreVarProtocol } from '@spinajs/configuration-aws-secretmanager-protocol';
import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';

function coerce(node: unknown): unknown {
  if (typeof node === 'string') {
    if (node === 'true' || node === 'false') {
      return node === 'true';
    }
    return node.trim() !== '' && !Number.isNaN(Number(node)) ? Number(node) : node;
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, coerce(value)]));
  }
  return node;
}

@Singleton()
@Injectable(ConfigVarProtocol)
export class TypedParameterStoreProtocol extends AwsParameterStoreVarProtocol {
  protected async fetchTree(path: string, withDecryption: boolean): Promise<Record<string, unknown>> {
    return coerce(await super.fetchTree(path, withDecryption)) as Record<string, unknown>;
  }
}

DI.unregister(AwsParameterStoreVarProtocol);

// config: billing: 'aws-parameters://prod/billing/*' -> { db: { port: 5432 }, ... }
```

## Important behaviour

- `DI.unregister()` takes effect only for resolves that follow it. Call it at module top level, after the import, before `Configuration` is resolved.
- Decorators are not inherited as registrations: without its own `@Injectable(ConfigVarProtocol)` a subclass is never in the protocol list.
- Both protocol singletons, with their caches and clients, are reused by every `load()` of every `Configuration` in the process.
- A `Client` assigned in the constructor is never rebuilt: `aws.secretsManager` / `aws.parameterStore` client options do not reach it, though `cacheTtl` still applies.
- `getVar()` receives the raw config object, not the `Configuration` service. Values other protocols produce may not be resolved yet.

## Best practices

- Prefer a subclass over a copy of the class: path parsing, fallbacks, caching and logging stay in sync with the package.
- Give a new scheme to a protocol that reads a different account or region instead of overloading `aws-secrets://`.
- Override `dispose()` to call `this.Client.destroy()` in long-running processes that rebuild the DI container.

## Patterns and antipatterns

```ts
// Don't: register a replacement without removing the original; two singletons claim
// 'aws-secrets://' and the winner depends on module evaluation order
@Singleton()
@Injectable(ConfigVarProtocol)
export class EnvScopedSecretsProtocol extends AwsSecretsManagerVarProtocol {}

// Do: remove the original explicitly
@Singleton()
@Injectable(ConfigVarProtocol)
export class EnvScopedSecretsProtocol extends AwsSecretsManagerVarProtocol {}
DI.unregister(AwsSecretsManagerVarProtocol);
```

## Examples

### Register a replacement in a bootstrap module

```ts sample
import { AwsSecretsManagerVarProtocol } from '@spinajs/configuration-aws-secretmanager-protocol';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Configuration, ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';

@Singleton()
@Injectable(ConfigVarProtocol)
export class TenantSecretsProtocol extends AwsSecretsManagerVarProtocol {
  public async getVar(path: string, configuration: any) {
    const tenant: string = configuration?.tenant?.id ?? 'shared';
    return super.getVar(`tenants/${tenant}/${path}`, configuration);
  }
}

export class TenantConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      tenant: { id: 'acme' },
      smtp: { password: 'aws-secrets://smtp#password' },
      aws: { secretsManager: { region: 'eu-central-1' } },
    };
  }
}

export async function bootstrap(): Promise<string> {
  DI.unregister(AwsSecretsManagerVarProtocol);
  DI.register(TenantConfiguration).as(Configuration);

  const config = await DI.resolve<Configuration>(Configuration);
  // fetched from 'tenants/acme/smtp'
  return config.get<string>('smtp.password');
}
```

## Related

- [Secrets Manager protocol](01-secrets-manager-protocol.md) and [Parameter Store protocol](02-parameter-store-protocol.md): the behaviour your subclass inherits.
- [Caching](04-caching.md): overriding the `cache` field.
- [Writing a custom protocol](06-writing-a-custom-protocol.md): a protocol for a store that is not AWS.
- [`@spinajs/di`](../di/README.md): `register`, `unregister`, `Array.ofType`.
