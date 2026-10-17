# Browser configuration

`BrowserFrameworkConfiguration` is the configuration service for browser and bundled builds. It has the same `get` / `set` / `merge` / `load` surface as `FrameworkConfiguration`, but no file loading, no schema validation, no protocols and no command-line or environment probing, so `fs`, `glob`, `path` and `ajv` stay out of the bundle.

## How it works

1. **Entry.** Bundlers that honour the `browser` export condition get `lib/<mjs|cjs>/index.browser.js` for `@spinajs/configuration`; any bundler can import `@spinajs/configuration/browser` explicitly. That entry exports `@spinajs/configuration-common`, the decorators, `InvalidConfiguration`, `_cfg` / `_service` and `BrowserFrameworkConfiguration`.
2. **Registration.** Importing the entry registers `BrowserFrameworkConfiguration` with `@Injectable(Configuration)`.
3. **`resolve()`** resolves `Array.ofType(ConfigurationSource)` when any source is registered, sorts it by `Order`, and calls `load()`. No source is fine.
4. **`load()`** resets the tree, merges each source's `Load()` result, then `onLoad()`, then every `__configuration__` DI value **at the root**, and wraps objects holding a `ConfigVar` in a proxy.
5. **`configure()`** calls each top-level section's `configure()` hook.

## Configuration

There are no option keys: the constructor ignores `ConfigurationOptions`. Values come from registered sources and `__configuration__` values only.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Configuration | `Configuration`, singleton (`@Injectable(Configuration)`) | `BrowserFrameworkConfiguration` | your own `Configuration` (see [Replacing the configuration service](09-replacing-the-configuration-service.md)) | Subclass it and override `onLoad()` or `configure()`; register with `DI.register(MyConfiguration).as(Configuration)`. |
| Sources | `ConfigurationSource`, optional | none | `StaticConfigurationSource(cfg, order)`, any custom source without Node APIs | Register under `ConfigurationSource` before the configuration resolves. |
| Code-only config | `__configuration__` DI values | none | none | `DI.register(obj).asValue('__configuration__')`; merged at the root, so new top-level keys are kept. |

### BrowserFrameworkConfiguration: configure a single-page app

Inject the server-rendered settings with a lazy static source, and add build-time constants with a `__configuration__` value.

```ts sample
import { DI } from '@spinajs/di';
import { Config, Configuration, ConfigurationSource, StaticConfigurationSource } from '@spinajs/configuration/browser';

declare global {
  interface Window {
    __APP_SETTINGS__?: Record<string, unknown>;
  }
}

DI.register(StaticConfigurationSource(() => window.__APP_SETTINGS__ ?? {}, 0)).as(ConfigurationSource);
DI.register({ build: { version: '2.4.1' } }).asValue('__configuration__');

class ApiClient {
  @Config('api.baseUrl', { defaultValue: '/api' })
  protected BaseUrl: string;

  public url(path: string) {
    return `${this.BaseUrl}${path}`;
  }
}

async function main() {
  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<string>('build.version'), DI.resolve(ApiClient).url('/orders'));
}

void main();
```

## Important behaviour

- No schema validation runs, so schema defaults are not applied. `registerConfigurationSchema` is not exported from the browser entry.
- No protocol strings are resolved, but a source may return `ConfigVar` values; they are read lazily as in Node.
- No `process.env` section, no `configuration.isProduction` flags and no `--app` / `--env` handling.
- `__configuration__` values are merged at the root: unlike `FrameworkConfiguration`, a new top-level key is kept.
- `mergeSource(sourceClass)` merges the source's result into the current tree and keeps the source for later `load()` calls.
- `cfg()`, `service()`, `registerConfigurationSchema()` and the file sources are Node-only exports; use `_cfg()` and `_service()` in the browser.
- Importing both entries in one process registers both classes under `Configuration`; the one imported last wins.

## Best practices

- Import from `@spinajs/configuration/browser` in code that only runs in the browser, so a bundler without the `browser` condition still skips the Node entry.
- Feed server-provided settings through a lazy `StaticConfigurationSource(() => ...)`, so they are read on `load()`, not at import.
- Validate settings on the server before rendering them into the page; the browser does not.

## Patterns and antipatterns

```ts
// Don't: the Node entry pulls fs, glob and ajv into the bundle
import { Configuration } from '@spinajs/configuration';

// Do
import { Configuration } from '@spinajs/configuration/browser';
```

## Related

- [Configuration service](01-configuration-service.md): the Node implementation.
- [Custom configuration sources](04-custom-configuration-sources.md): `StaticConfigurationSource` and source ordering.
- [`@spinajs/configuration-common`](../configuration-common/README.md): the browser-safe contracts.
