# Scan services

`@ResolveFromFiles` and `@ListFromFiles` register nothing, but each scan resolves three services from the root container: the configuration it reads directories from, a logger, and the module loader that imports each file. Replace any of them to change how every scan in the app behaves.

## How it works

1. **Configuration.** On the first read, the scan calls `DI.get(Configuration)` and reads `configPath` from it. `DI.get()` returns the instance already in the root cache; it does not build one.
2. **Logger.** It calls `DI.check(Log)`. When a `Log` implementation is registered (importing `@spinajs/log` registers one), it resolves `DI.resolve(Log, ['reflection'])`. Otherwise it resolves `DI.resolve(InternalLoggerProxy, ['reflection'])`.
3. **Module loader.** For each file it calls `DI.__spinajs_require__(file)`. That function delegates to the value registered as `__module_loader__` when there is one, else to `import()`.

Each service is looked up per scan, on its first read, not at decoration time.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Configuration | `Configuration` (from `@spinajs/configuration-common`, re-exported by `@spinajs/configuration`); singleton; read with `DI.get()` from the root container | `FrameworkConfiguration` | Any `Configuration` subclass, eg. a test configuration | `DI.register(MyConfig).as(Configuration)`, then `await DI.resolve(Configuration)` before the first read |
| Logger | `Log` from `@spinajs/log-common`, resolved by type with the constructor argument `'reflection'` | The `@spinajs/log` logger named `reflection` | `InternalLoggerProxy` when no `Log` is registered; your own `Log` | Register a `Log` implementation, or configure a `logger.rules` entry for `reflection` |
| Fallback logger | `InternalLoggerProxy`; singleton (no decorator) | `InternalLoggerProxy` | Your subclass | `DI.register(MyProxy).as(InternalLoggerProxy)` before the first scan |
| Module loader | Value `__module_loader__` in the root container; read on every file | none: `import()` | Your `DI.IModuleLoader` | `DI.register(loader).asValue('__module_loader__')` before `Configuration` resolves, because config files load through it too |

### Configuration: custom implementation

Replace the configuration in tests, to point a scan at fixture directories without config files. `FrameworkConfiguration.onLoad()` returns an object merged over the loaded files: `system.dirs.*` arrays are added to, other value arrays are replaced (see [Arrays](../configuration/01-configuration-service.md#arrays)). Register the subclass before anything resolves `Configuration`, and resolve it before the first read.

```ts sample
import { join, resolve } from 'path';
import { ClassInfo, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { ListFromFiles } from '@spinajs/reflection';

export class FixtureConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      system: {
        dirs: {
          importJobs: [resolve(join(process.cwd(), 'test', 'fixtures', 'import-jobs'))],
        },
      },
    };
  }
}

export class ImportJobCatalog {
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.importJobs')
  public Jobs!: Promise<ClassInfo<unknown>[]>;
}

async function main() {
  DI.clearCache();
  DI.register(FixtureConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const jobs = await DI.resolve(ImportJobCatalog).Jobs;
  console.log(jobs.map((j) => j.name));
}

void main();
```

### Logger: custom implementation

With `@spinajs/log` loaded, the scan logs through the logger named `reflection`. Route it with a rule (see [Configuration and rules](../log/02-configuration-and-rules.md)); `trace` shows every file the scan imports, `warn` shows missing directories.

```ts
// src/config/logger.ts in your application; `Console` is a target defined in logger.targets
export default {
  logger: {
    rules: [{ name: 'reflection', level: 'trace', target: 'Console', final: true }],
  },
};
```

Without `@spinajs/log`, the scan uses `InternalLoggerProxy`. That proxy is a singleton, so the first name resolved anywhere is reused, and scan messages can carry another package's name. Register a subclass with `@NewInstance()` so each caller, the scan included, gets its own name.

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { InternalLoggerProxy } from '@spinajs/internal-logger';

@NewInstance()
export class NamedInternalLoggerProxy extends InternalLoggerProxy {}

// Before the first scan or the first DI.resolve(InternalLoggerProxy, [...]).
DI.register(NamedInternalLoggerProxy).as(InternalLoggerProxy);

const log = DI.resolve(InternalLoggerProxy, ['reflection']);
log.info({}, 'scan logger ready');
```

See [Logger proxy](../internal-logger/03-logger-proxy.md#services-and-extension-points) for more on the proxy.

### Module loader: custom implementation

Register a loader to change how scanned files are imported: measure slow imports, map paths in a bundle, or serve fixtures from memory. The loader receives the path `glob` returned, or a `file://` URL from other callers. Its return value is used as is; the scan reads `Object.keys()` of it, so return the module namespace or a named-exports object.

```ts sample
import { pathToFileURL } from 'url';
import { DI } from '@spinajs/di';

/** Logs every module that takes longer than 200 ms to import. */
export class TimedModuleLoader implements DI.IModuleLoader {
  public async load(module: string): Promise<unknown> {
    const url = module.startsWith('file://') ? module : pathToFileURL(module).href;
    const started = Date.now();
    const loaded = (await import(url)) as { default?: unknown };
    const elapsed = Date.now() - started;

    if (elapsed > 200) {
      console.warn(`slow import ${module}: ${elapsed} ms`);
    }

    // Same unwrapping as the built-in ESM path, so config files keep working.
    return loaded.default ?? loaded;
  }
}

// First thing in the entry file, before Configuration loads its files.
DI.register(new TimedModuleLoader()).asValue('__module_loader__');
```

See [Module loading](../di/13-module-loading.md) for the loader contract.

## Important behaviour

- **Everything is read from the root container.** Registering a configuration, logger or loader in a child container has no effect on scans.
- **`Configuration` is not built by the scan.** When it was never resolved, the scan's `Promise` rejects with a `ReflectionException`.
- **The logger choice is made per scan.** A scan that starts before `@spinajs/log` is imported logs through `InternalLoggerProxy` for its whole run.
- **A registered loader takes over every module load,** not only scans: configuration files, migrations and translations go through it too.

## Best practices

- Resolve `Configuration` at the start of boot, before any service with a scanned property is read; the framework's bootstrap does this.
- In tests, call `DI.clearCache()` and register the test configuration in each `beforeEach`, then `await DI.resolve(Configuration)`.
- Import `@spinajs/log` before the first scan when you want scan messages filtered by `logger.rules`.

## Related

- [Loading classes from directories](01-loading-classes-from-directories.md): where these services are used.
- [Configuration service](../configuration/01-configuration-service.md): `FrameworkConfiguration`, `onLoad()` and array merging.
- [Logger proxy](../internal-logger/03-logger-proxy.md): the fallback logger.
- [Module loading](../di/13-module-loading.md): `DI.__spinajs_require__` and `__module_loader__`.
