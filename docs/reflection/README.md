# `@spinajs/reflection`

Loads classes from directories named in configuration, and optionally resolves them through `@spinajs/di`. It also re-exports the `use` and `delegate` mixin decorators and ships `TypescriptCompiler`, a reader for method declarations in a TypeScript source file.

It does **not** register anything in DI by itself, and it does **not** watch directories: a scan runs once, on the first read of the decorated property. It is not `reflect-metadata`; decorator metadata lives in [`@spinajs/di`](../di/README.md).

## Install

```sh
npm install @spinajs/reflection
```

The scan decorators read `Configuration` from the container, so a `@spinajs/configuration` implementation must be resolved before the first read. Decorated properties are accessors on the prototype: keep `useDefineForClassFields: false` in `tsconfig.json`, as [`@spinajs/di`](../di/README.md#install) requires.

The `browser` export of the package contains only `use` and `delegate`.

## Features

| Feature | What it does |
| --- | --- |
| [Loading classes from directories](01-loading-classes-from-directories.md) | `@ResolveFromFiles` and `@ListFromFiles`: glob the directories of a config key, import each file, return `ClassInfo` entries with or without a resolved instance |
| [Choosing and resolving scanned classes](02-choosing-and-resolving-scanned-classes.md) | The type matcher argument, and how the scanned class's own DI lifetime and `AsyncService` base decide what `instance` holds |
| [Scan services](03-scan-services.md) | The services a scan resolves (`Configuration`, `Log` or `InternalLoggerProxy`, the `__module_loader__` seam) and how to replace each one |
| [Pluggable discovery sources](04-pluggable-discovery-sources.md) | The pattern `@spinajs/http`, `@spinajs/cli` and `@spinajs/http-socket` use: an abstract source in DI, a filesystem implementation built on `@ListFromFiles`, and alternatives next to it |
| [Mixins](05-mixins.md) | `use` and `delegate`, re-exported from `typescript-mix`: copy methods of other classes or objects into a class |
| [TypeScript source inspection](06-typescript-source-inspection.md) | `TypescriptCompiler.getClassMembers()`: the method declarations of a named class in a `.ts` file |

`ReflectionException` (extends `Exception` from `@spinajs/exceptions`) is exported for callers that want a reflection-specific error. The package itself never throws it.

## Extension points at a glance

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| Configuration the scan reads | `Configuration`; read with `DI.get()` from the root container, so it must already be resolved | `FrameworkConfiguration` from `@spinajs/configuration` | `DI.register(MyConfig).as(Configuration)`. See [Scan services](03-scan-services.md#configuration-custom-implementation) |
| Scan logger | `Log` resolved with the name `reflection` when registered, else `InternalLoggerProxy` | `InternalLoggerProxy` until `@spinajs/log` is imported | Register a `Log` or `InternalLoggerProxy` subclass. See [Scan services](03-scan-services.md#logger-custom-implementation) |
| Module loader | Value `__module_loader__` in the root container | none: `import()` or `require()` | `DI.register(loader).asValue('__module_loader__')`. See [Scan services](03-scan-services.md#module-loader-custom-implementation) |
| Scanned class lifetime | The scanned class itself, resolved by type in the root container | Singleton | `@NewInstance()`, `@PerChildInstance()`, `AsyncService`. See [Choosing and resolving scanned classes](02-choosing-and-resolving-scanned-classes.md) |
| Export picked per file | The `typeMatcher` argument | First export key | A function `(fileName) => exportName`. See [Choosing and resolving scanned classes](02-choosing-and-resolving-scanned-classes.md#type-matcher) |
| Discovery source | Your abstract class, `@Injectable(Base)` per implementation, injected as a list | none in this package | See [Pluggable discovery sources](04-pluggable-discovery-sources.md) |
| Mixed-in behaviour | `@use(...)` on a class | none | Pass classes or object literals. See [Mixins](05-mixins.md) |

## Quick start

```ts sample
import { ClassInfo, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ListFromFiles } from '@spinajs/reflection';

export abstract class ImportJob {
  public abstract run(): Promise<void>;
}

// Each `.js` or `.ts` file under the directories in `system.dirs.importJobs` exports one job class.
export class ImportJobCatalog {
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.importJobs')
  public Jobs!: Promise<ClassInfo<ImportJob>[]>;
}

async function main() {
  await DI.resolve(Configuration);

  const catalog = DI.resolve(ImportJobCatalog);
  for (const job of await catalog.Jobs) {
    console.log(`${job.name} from ${job.file}`);
  }
}

void main();
```

## Related packages

- [`@spinajs/di`](../di/README.md): resolves scanned classes, provides `ClassInfo` and the [module loading](../di/13-module-loading.md) seam.
- [`@spinajs/configuration`](../configuration/README.md): holds the `system.dirs.*` keys the scans read.
- [`@spinajs/internal-logger`](../internal-logger/README.md): the [logger proxy](../internal-logger/03-logger-proxy.md) used before `@spinajs/log` is loaded.
- [`@spinajs/http`](../http/03-controller-discovery.md): scans `system.dirs.controllers` with `@ListFromFiles`.
- [`@spinajs/cli`](../cli/05-command-discovery.md): scans `system.dirs.cli` with `@ListFromFiles`.
- [`@spinajs/orm`](../orm/README.md): composes its query builders with `@use`.
