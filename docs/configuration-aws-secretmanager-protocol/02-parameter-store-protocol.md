# Parameter Store protocol

`aws-parameters://` replaces a config string with a parameter from AWS Systems Manager Parameter Store. Use it for settings shared across services: endpoints, feature switches, whole per-environment trees.

```
aws-parameters://<name>[:<version|label>][?withDecryption=true|false][&default=<value>|&optional=true][#<json.path>]
aws-parameters://<path>/*[?withDecryption=true|false][&default=<value>|&optional=true]
```

| Part | Meaning |
| --- | --- |
| `<name>` | Parameter name, sent to AWS as written. A hierarchical name needs its leading slash, so write three slashes: `aws-parameters:///prod/billing/endpoint`. |
| `:<version\|label>` | AWS native selector, part of the name: `/prod/billing/endpoint:3`. |
| `withDecryption` | Decrypt `SecureString` parameters. Default `true`. Only `true` and `false` are accepted; anything else logs a warning and uses `true`. |
| `default`, `optional` | Fallback when the fetch fails. See [Fallbacks and failures](03-fallbacks-and-failures.md). |
| `#<json.path>` | Parse the value as JSON and return one key, dot notation (`#database.password`). |
| `/*` | Expand every parameter under the path into a nested object. |

## How it works

### Single parameter

1. `FrameworkConfiguration.loadProtocolVars()` finds the string and calls `AwsParameterStoreVarProtocol.getVar(rest, rawConfig)`. Steps 1 to 4 of the [Secrets Manager flow](01-secrets-manager-protocol.md#how-it-works) apply unchanged.
2. On its first call `getVar()` builds the `SSMClient` from `aws.parameterStore` in the raw config, without `cacheTtl`.
3. `parseAwsPath()` splits the path; `warnUnknownParams()` logs every parameter other than `withDecryption`, `default`, `optional`; `parseBoolParam()` reads `withDecryption`.
4. `TtlCache.resolve()`, keyed by name and `withDecryption`, returns a cached value or sends `GetParameterCommand({ Name, WithDecryption })`.
5. A `StringList` parameter is split on `,` and returned as `string[]`. With `#json.path` the list is rejoined with `,` and parsed as JSON.
6. With `#json.path`, `extractValue()` parses the value as JSON and returns the key. Otherwise the value is returned, or `''` when AWS returns none.
7. A failed fetch goes to `resolveFallback()`, then is rethrown; `FrameworkConfiguration` logs it and keeps the raw string.

### Hierarchy (`/*`)

1. `getVar()` sees the trailing `/*`, strips it and prefixes `/` when missing: `prod/myapp/*` and `/prod/myapp/*` both read `/prod/myapp`.
2. `TtlCache.resolve()`, keyed by path and `withDecryption`, calls the protected `fetchTree(path, withDecryption)`.
3. `fetchTree()` sends `GetParametersByPathCommand({ Path, Recursive: true, WithDecryption, NextToken })` until AWS returns no `NextToken`.
4. Each parameter name loses the path prefix and is split on `/`; `assignNested()` writes the value at that nested key.
5. The nested object replaces the config string. A path with no parameters gives `{}`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `aws.parameterStore` | object | `{}` | `SSMClientConfig` keys | Passed to `new SSMClient()`: `region`, `credentials`, `endpoint`, `maxAttempts`, ... |
| `aws.parameterStore.cacheTtl` | number (ms) | `300000` (`DEFAULT_CACHE_TTL`) | any number; `<= 0` disables caching | How long a fetched parameter or tree is reused. See [Caching](04-caching.md). |
| `aws.parameterStore.logger` | - | - | - | Ignored: the client logs through `createSdkLogger('AwsParameterStoreVarProtocol')`. |

```ts
aws: {
  parameterStore: {
    region: 'eu-central-1',
    cacheTtl: 0,
  },
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AwsParameterStoreVarProtocol` | `ConfigVarProtocol` (one entry of the list) and `AwsParameterStoreVarProtocol`; singleton; registered by decorators at import | itself | none shipped | Subclass it and `DI.unregister(AwsParameterStoreVarProtocol)`; see [Replacing and extending](05-replacing-and-extending-the-aws-protocols.md) |
| `fetchTree()` | protected method | recursive, paginated `GetParametersByPath` | - | Override to post-process or filter a hierarchy |
| `SSMClient` | not in DI; `protected Client` field | built on the first `getVar()` from `aws.parameterStore` | any client you assign | Assign `this.Client` in a subclass constructor |
| `TtlCache` | not in DI; `protected cache` field | `new TtlCache()` | any `TtlCache` | Override the field in a subclass; see [Caching](04-caching.md) |

## Important behaviour

- `SecureString` values are decrypted by default. `?withDecryption=false` returns the ciphertext.
- Every value is a string, except a `StringList`, which is a `string[]`. Numbers and booleans are not converted: `port` comes back as `'5432'`.
- In hierarchy mode every leaf is the raw string, `StringList` values included; `#json.path` is ignored.
- A tree where one name is both a leaf and a parent (`/app/db` and `/app/db/host`) keeps the branch (`/app/db/host`) whatever order AWS returns them in; the leaf value is dropped.
- The fallback of a hierarchy is a string: `?optional=true` on `/*` yields `''`, not `{}`.
- The client is built once per protocol instance. Changes to `aws.parameterStore` take effect after a restart.
- Names are case-sensitive and sent unchanged, so the single-parameter form does **not** add the leading `/` that hierarchy mode adds.

## Best practices

- Group a service's settings under one path (`/prod/billing/...`) and load them with one `/*` instead of one string per key.
- Grant `ssm:GetParameter` for single reads, `ssm:GetParametersByPath` for `/*`, and `kms:Decrypt` for `SecureString` parameters.
- Convert types in your config class or service (`Number(config.get('billing.db.port'))`), or in a [subclass of the protocol](05-replacing-and-extending-the-aws-protocols.md#parameter-store-typed-hierarchy-values).
- Keep secrets in Secrets Manager and read them with `aws-secrets://`; use Parameter Store for settings.

## Patterns and antipatterns

```ts
// Don't: one AWS call per key, and the names lack the leading slash AWS requires for a hierarchy
billing: {
  host: 'aws-parameters://prod/billing/db/host',
  port: 'aws-parameters://prod/billing/db/port',
  endpoint: 'aws-parameters://prod/billing/endpoint',
},

// Do: one paginated call for the whole subtree
billing: 'aws-parameters://prod/billing/*',
```

## Examples

### Load a service's settings from one hierarchy

```ts sample
import '@spinajs/configuration-aws-secretmanager-protocol';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';

// Parameter Store holds:
//   /prod/billing/db/host            String       db.internal
//   /prod/billing/db/port            String       5432
//   /prod/billing/allowedCurrencies  StringList   EUR,PLN,USD
//   /prod/billing/smtp               String       {"host":"smtp.internal","port":587}
export class BillingConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      billing: 'aws-parameters://prod/billing/*',
      currencies: 'aws-parameters:///prod/billing/allowedCurrencies',
      smtpHost: 'aws-parameters:///prod/billing/smtp#host',
      endpoint: 'aws-parameters:///prod/billing/endpoint:2',
      aws: {
        parameterStore: { region: 'eu-central-1' },
      },
    };
  }
}

export async function billingSettings() {
  DI.register(BillingConfiguration).as(Configuration);
  const config = await DI.resolve<Configuration>(Configuration);

  return {
    dbHost: config.get<string>('billing.db.host'),
    dbPort: Number(config.get<string>('billing.db.port')),
    currencies: config.get<string[]>('currencies'),
    smtpHost: config.get<string>('smtpHost'),
    endpoint: config.get<string>('endpoint'),
  };
}
```

## Related

- [Secrets Manager protocol](01-secrets-manager-protocol.md): the full load flow and the sibling protocol for secrets.
- [Fallbacks and failures](03-fallbacks-and-failures.md): what a failed read leaves in the config.
- [Replacing and extending the AWS protocols](05-replacing-and-extending-the-aws-protocols.md): override `fetchTree()`.
