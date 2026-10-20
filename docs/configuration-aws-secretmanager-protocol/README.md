# `@spinajs/configuration-aws-secretmanager-protocol`

Resolves configuration values from AWS Secrets Manager (`aws-secrets://`) and AWS Systems Manager Parameter Store (`aws-parameters://`) while `@spinajs/configuration` loads the config.

Any config string that starts with one of these protocols is replaced with the value fetched from AWS. The package does **not** watch AWS for changes: a value is fetched on config load, and only a later `Configuration.load()` fetches it again.

## Install

```sh
npm install @spinajs/configuration-aws-secretmanager-protocol
```

Import the package once, before `Configuration` is resolved. The import registers both protocols in DI.

## Features

| Feature | What it does |
| --- | --- |
| [Secrets Manager protocol](01-secrets-manager-protocol.md) | `aws-secrets://` resolves a secret, a version of it, or one key of a JSON secret. |
| [Parameter Store protocol](02-parameter-store-protocol.md) | `aws-parameters://` resolves a parameter, a `StringList`, or a whole hierarchy into a nested object. |
| [Fallbacks and failures](03-fallbacks-and-failures.md) | `?default=` and `?optional=true` for values AWS cannot deliver; what happens without them. |
| [Caching](04-caching.md) | `TtlCache`: per-protocol TTL cache with in-flight de-duplication, `cacheTtl` and `clearCache()`. |
| [Replacing and extending the AWS protocols](05-replacing-and-extending-the-aws-protocols.md) | Subclass a shipped protocol, bring your own SDK client, swap the default out of DI. |
| [Writing a custom protocol](06-writing-a-custom-protocol.md) | Implement `ConfigVarProtocol` for another secret store, reusing this package's helpers. |

## Quick start

```ts sample
import '@spinajs/configuration-aws-secretmanager-protocol';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';

export class AppConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      db: {
        password: 'aws-secrets://prod/db/credentials#password',
      },
      billing: {
        endpoint: 'aws-parameters:///prod/billing/endpoint',
      },
      aws: {
        secretsManager: { region: 'eu-central-1' },
        parameterStore: { region: 'eu-central-1' },
      },
    };
  }
}

export async function bootstrap(): Promise<string> {
  DI.register(AppConfiguration).as(Configuration);
  const config = await DI.resolve<Configuration>(Configuration);
  return config.get<string>('db.password');
}
```

Credentials and region follow the standard AWS SDK chain (`AWS_*` environment variables, shared config files, instance or task roles). Keys under `aws.secretsManager` and `aws.parameterStore` go to the SDK clients.

## Exports

| Export | Kind | Page |
| --- | --- | --- |
| `AwsSecretsManagerVarProtocol` | class, DI singleton under `ConfigVarProtocol` | [01](01-secrets-manager-protocol.md), [05](05-replacing-and-extending-the-aws-protocols.md) |
| `AwsParameterStoreVarProtocol` | class, DI singleton under `ConfigVarProtocol` | [02](02-parameter-store-protocol.md), [05](05-replacing-and-extending-the-aws-protocols.md) |
| `TtlCache`, `DEFAULT_CACHE_TTL` | class, constant | [04](04-caching.md) |
| `parseAwsPath`, `ParsedAwsPath` | function, interface | [06](06-writing-a-custom-protocol.md) |
| `resolveFallback`, `FallbackResult` | function, interface | [03](03-fallbacks-and-failures.md), [06](06-writing-a-custom-protocol.md) |
| `warnUnknownParams`, `parseBoolParam`, `extractValue`, `assignNested`, `createSdkLogger` | functions | [06](06-writing-a-custom-protocol.md) |

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): `FrameworkConfiguration` walks the config and calls the protocols during `load()`.
- [`@spinajs/configuration-common`](../configuration-common/README.md): defines the `ConfigVarProtocol` contract both protocols implement.
- [`@spinajs/configuration-fs-protocol`](../configuration-fs-protocol/README.md): another `ConfigVarProtocol`, for values read from files.
- [`@spinajs/di`](../di/README.md): registers the protocols and resolves them as `Array.ofType(ConfigVarProtocol)`.
- [`@spinajs/internal-logger`](../internal-logger/README.md): receives the protocols' warnings and the AWS SDK log output.
