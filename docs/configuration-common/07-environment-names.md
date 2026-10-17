# Environment names

`normalizeEnvironment(env)` turns an `APP_ENV` value into the environment name SpinaJS matches file suffixes against. Config files (`http.dev.json`) and migrations (`Foo_2026_07_29_10_00_00.dev.ts`) both use it, so they always agree on what `dev` means.

```ts
function normalizeEnvironment(env?: string | null): string;
```

## How it works

1. `undefined`, `null` and `''` become `'production'`.
2. `'dev'` and `'development'` return `'dev'`.
3. `'prod'` and `'production'` return `'prod'`.
4. Any other value is returned unchanged, case included.

| Input | Result |
| --- | --- |
| `'dev'`, `'development'` | `'dev'` |
| `'prod'`, `'production'` | `'prod'` |
| `undefined`, `null`, `''` | `'prod'` |
| `'staging'` | `'staging'` |
| `'Local'` | `'Local'` (not folded to `'local'`) |
| `'DEV'` | `'DEV'` (not an alias) |

## Who calls it

| Caller | Package | Input |
| --- | --- | --- |
| `BaseFileSource.getEnvironment()` | `@spinajs/configuration` | the `process.env.APP_ENV` config value, which `load()` sets from `--env`, `APP_ENV`, `NODE_ENV`, else `'development'`; selects `*.<env>.js` and `*.<env>.json` |
| default `configuration` section | `@spinajs/configuration` | `APP_ENV ?? NODE_ENV ?? 'development'` |
| migration loading | `@spinajs/orm` | `process.env.APP_ENV` from config, and the environment segment of a migration file name |
| production checks | `@spinajs/email`, `@spinajs/authz` | `APP_ENV ?? NODE_ENV ?? 'development'`, compared with `'prod'` |
| development policy | `@spinajs/telemetry` | the configured value, else `APP_ENV ?? NODE_ENV`, compared with `'dev'` |

## Services and extension points

`normalizeEnvironment()` is a plain function, not a DI service. It cannot be replaced; it is deliberately the single definition. To map your own environment names, subclass a source and override `getEnvironment()`, as shown in [Configuration sources](05-configuration-sources.md#extend-a-shipped-source).

## Important behaviour

- **Empty means production.** `APP_ENV=` (exported but blank) or `--env=` loads the `prod` files, not none.
- **Case matters.** `APP_ENV=Dev` looks for `*.Dev.json`, which most projects do not have; only the common files load.
- **Only two aliases exist.** `test`, `stage` and others are used verbatim as file suffixes.
- **Callers choose their own default for unset.** The function maps unset to `prod`, but several callers pass `?? 'development'` first, so an unset `APP_ENV` is `dev` for them.

## Best practices

- Name environment files with the short form: `*.dev.json`, `*.prod.json`.
- Compare against the normalized value (`normalizeEnvironment(x) === 'prod'`), never against raw `APP_ENV`.
- Set `APP_ENV` explicitly in every deployment; do not rely on the unset default, which differs between callers.

## Examples

### Gate a production-only behaviour

```ts sample
import { normalizeEnvironment } from '@spinajs/configuration-common';

export function isProduction(env: string | undefined = process.env.APP_ENV ?? process.env.NODE_ENV): boolean {
  return normalizeEnvironment(env) === 'prod';
}

// true for "production", "prod", "" and undefined; false for "staging"
console.log(isProduction('production'), isProduction('staging'));
```

## Related

- [Configuration sources](05-configuration-sources.md): file sources pick `*.<env>.json` with this function.
- [`@spinajs/orm`](../orm/10-migrations.md): migration files carry an environment segment normalized the same way.
