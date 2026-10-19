# Fallbacks and failures

Two opt-in query parameters decide what a protocol string resolves to when AWS cannot deliver it: `?default=<value>` and `?optional=true`. Without them a failure leaves the raw protocol string in the config.

## How it works

1. `getVar()` of either protocol wraps the cached AWS fetch in `try`/`catch`.
2. On an error it calls `resolveFallback(params, source, id, err)`.
3. `resolveFallback()` checks `default` first: when present it logs a warning and returns `{ handled: true, value: <default> }`.
4. Otherwise `optional=true` logs a warning and returns `{ handled: true, value: '' }`.
5. Otherwise it returns `{ handled: false }` and `getVar()` rethrows.
6. `FrameworkConfiguration.loadProtocolVars()` catches the error, logs `Error loading configuration var for key <key> using protocol <protocol>` and leaves the original string, e.g. `aws-secrets://prod/db/credentials#password`, in the config. Loading continues.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `?default=<value>` | query parameter | - | any URL-encoded string | Value used when the fetch fails. Always a string. |
| `?optional=true` | query parameter | - | `true` | Resolve to `''` when the fetch fails. Any other value, e.g. `optional=1`, is not a fallback. |

When both are present, `default` wins.

```ts
db: {
  password: 'aws-secrets://prod/db/credentials?default=localdev#password',
  readOnlyPassword: 'aws-secrets://prod/db/readonly?optional=true#password',
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `resolveFallback()` | exported function, not in DI | `default`, then `optional=true` | - | Call it from a custom protocol to give it the same parameters; see [Writing a custom protocol](06-writing-a-custom-protocol.md) |

## Important behaviour

- A fallback applies to **any** fetch error: missing secret, missing credentials, `AccessDenied`, throttling. The warning in `InternalLogger` is the only trace of a real misconfiguration.
- A fallback applies only to errors. A secret that exists but is empty resolves to `''`, not to the default.
- A fallback also covers `#json.path` on a value that is not valid JSON: `?default=` / `?optional=true` apply as for a failed fetch.
- A missing JSON key is not an error: `#json.path` returns `''` and the default is not used.
- Failures are never cached. Every later `load()` retries AWS.
- The default value is decoded by `URLSearchParams`: `+` becomes a space, `%xx` is decoded, `&` ends the value. A `#` in it starts the JSON path, so encode it as `%23`.
- The fallback value is always a string, also on a `/*` hierarchy.
- Unknown query parameters (e.g. `?versionstage=`) are logged by `warnUnknownParams()` and ignored, so a typo silently falls back to the default behaviour.

## Best practices

- Use `?default=` only for values a local or test run can work with; leave production-critical secrets without a fallback.
- After `load()`, check that no config value still starts with `aws-secrets://` or `aws-parameters://`, and stop startup when one does. See the example below.
- Route `InternalLogger` warnings to a monitored target; they are the signal that a fallback was used.

## Patterns and antipatterns

```ts
// Don't: a fallback on a production credential hides AccessDenied behind a working-looking value
db: { password: 'aws-secrets://prod/db/credentials?default=postgres#password' },

// Do: no fallback for production, fail startup on an unresolved value (see the example)
db: { password: 'aws-secrets://prod/db/credentials#password' },
```

## Examples

### Fail startup when a secret did not resolve

```ts sample
import '@spinajs/configuration-aws-secretmanager-protocol';
import { Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';

const UNRESOLVED = /^aws-(secrets|parameters):\/\//;

function findUnresolved(node: unknown, path: string[] = []): string[] {
  if (typeof node === 'string') {
    return UNRESOLVED.test(node) ? [path.join('.')] : [];
  }
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => findUnresolved(value, [...path, key]));
  }
  return [];
}

export async function assertSecretsResolved(): Promise<Configuration> {
  const config = await DI.resolve<Configuration>(Configuration);
  const missing = findUnresolved(config.get<Record<string, unknown>>('db'));

  if (missing.length > 0) {
    throw new Error(`Unresolved AWS configuration values: ${missing.join(', ')}`);
  }
  return config;
}
```

### Run locally without AWS credentials

```ts sample
import '@spinajs/configuration-aws-secretmanager-protocol';
import { FrameworkConfiguration } from '@spinajs/configuration';

export class LocalConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      db: {
        user: 'aws-secrets://dev/db/credentials?default=postgres#username',
        password: 'aws-secrets://dev/db/credentials?default=postgres#password',
      },
      features: {
        newCheckout: 'aws-parameters:///dev/features/newCheckout?default=false',
        bannerText: 'aws-parameters:///dev/features/banner?optional=true',
      },
    };
  }
}
```

## Related

- [Secrets Manager protocol](01-secrets-manager-protocol.md) and [Parameter Store protocol](02-parameter-store-protocol.md): the fetches these fallbacks guard.
- [Caching](04-caching.md): why a failure is retried on the next load.
- [`@spinajs/configuration`](../configuration/README.md): the loader that logs the error and keeps the raw string.
