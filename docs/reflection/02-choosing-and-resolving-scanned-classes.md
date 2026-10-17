# Choosing and resolving scanned classes

A scan builds one `ClassInfo` per file. Two things decide what it holds: the `typeMatcher` you pass, which picks the export, and the scanned class's own DI setup, which decides what `@ResolveFromFiles` puts in `instance`.

## How it works

1. **Export keys.** For each imported module, the scan reads `Object.keys(module)` and takes the first key.
2. **Export name.** With a `typeMatcher`, the name is `typeMatcher(path.parse(file).name)`: the file's base name without its last extension; see [Type matcher](#type-matcher). Without one, the name is the first key.
3. **Type.** `type` is `module[name]`.
4. **List mode.** `@ListFromFiles` returns `{ file, name, type, instance: undefined }` and moves to the next file.
5. **Resolve mode.** `@ResolveFromFiles` checks `type.prototype instanceof AsyncService`:
   - `AsyncService`: it awaits `DI.resolve(type)`, which runs `resolve()` on a new instance, and stores the result.
   - Any other class: it stores the value `DI.resolve(type)` returns, without awaiting it.
6. **Lifetime.** `DI.resolve(type)` honours the class's lifetime decorator. Without one, the class is a singleton in the root container.
7. **Errors.** A synchronous resolve error is logged at `error`, and the scan tries the next export key of the same file with the same name rule. When no key succeeds, the file yields no entry.

### Type matcher

`path.parse(file).name` strips only the last extension:

| File | `fileName` passed to the matcher |
| --- | --- |
| `jobs/monthly-invoices.js` | `monthly-invoices` |
| `jobs/MonthlyInvoices.ts` | `MonthlyInvoices` |
| `jobs/monthly-invoices.job.js` | `monthly-invoices.job` |

The matcher returns the export name to use. A name that is not exported gives `type: undefined`: `@ListFromFiles` returns the entry anyway, and `@ResolveFromFiles` rejects the whole scan with a `TypeError`.

### Scanned class lifetime

| Scanned class | `instance` from `@ResolveFromFiles` | Cached in DI |
| --- | --- | --- |
| No decorator | One shared instance | Yes, root container, under the class name |
| `@Singleton()` | One shared instance | Yes |
| `@NewInstance()` | A new instance for each scan; later `DI.resolve()` calls build more | No |
| `@PerChildInstance()` | The root container's instance, since the scan resolves in the root | Yes, per container |
| Extends `AsyncService` | The instance after its `resolve()` finished | Per its lifetime decorator |
| Registered as another class with `DI.register(Impl).as(Scanned)` | An `Impl` instance | Per `Impl`'s lifetime |

See [Lifetimes](../di/04-lifetimes.md) and [Service lifecycle](../di/10-service-lifecycle.md) for the decorators and `AsyncService`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Export picker | The `typeMatcher` argument of the decorator | First export key | Any `(fileName: string) => string` | Pass a function; see [Type matcher: custom implementation](#type-matcher-custom-implementation) |
| Scanned class | The class itself, by type, root container | Singleton | `@NewInstance()`, `@PerChildInstance()`, `AsyncService` | Decorate the scanned class, or `DI.register(Impl).as(Scanned)` before the first read |

### Type matcher: custom implementation

Pass a matcher when a scanned file exports more than one name and the class is not the first. A file that exports its DTOs above the class is the common case. Derive the export name from the file name with a fixed convention.

```ts sample
import { ClassInfo, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ListFromFiles } from '@spinajs/reflection';

// `monthly-invoices.report.js` exports `MonthlyInvoicesReport`, next to its row types.
function reportClassName(fileName: string): string {
  const base = fileName.replace(/\.report$/, '');
  const pascal = base
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${pascal}Report`;
}

export class ReportCatalog {
  @ListFromFiles('/**/*.report.{ts,js}', 'system.dirs.reports', reportClassName)
  public Reports!: Promise<ClassInfo<unknown>[]>;
}

async function main() {
  await DI.resolve(Configuration);

  const reports = await DI.resolve(ReportCatalog).Reports;
  for (const report of reports) {
    if (!report.type) {
      console.warn(`${report.file} does not export ${report.name}`);
      continue;
    }
    console.log(`report ${report.name} found in ${report.file}`);
  }
}

void main();
```

### Scanned class: control its lifetime and async start

A scanned class needs nothing from this package. Decorate it like any service: `@NewInstance()` for a fresh object on every resolve, `AsyncService` for asynchronous start-up the scan awaits.

```ts sample
import { AsyncService, ClassInfo, DI, NewInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ResolveFromFiles } from '@spinajs/reflection';

// lib/exchange-rates/EcbRateProvider.js, under `system.dirs.rateProviders`
@NewInstance()
export class EcbRateProvider extends AsyncService {
  public Rates = new Map<string, number>();

  // Awaited by @ResolveFromFiles before the entry is returned.
  public async resolve(): Promise<void> {
    this.Rates.set('EUR/PLN', 4.31);
    this.Rates.set('EUR/USD', 1.08);
    await super.resolve();
  }
}

export class RateProviders {
  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.rateProviders')
  public Providers!: Promise<ClassInfo<EcbRateProvider>[]>;
}

async function main() {
  await DI.resolve(Configuration);

  for (const provider of await DI.resolve(RateProviders).Providers) {
    console.log(provider.name, provider.instance?.Rates.get('EUR/PLN'));
  }
}

void main();
```

## Important behaviour

- **Only named exports are seen.** In ESM mode a default export is unwrapped by `DI.__spinajs_require__`, so the scan reads the class's static keys, not the module's exports.
- **"First" depends on the module mode.** An ESM namespace object lists its export names in alphabetical order. A CommonJS `exports` object lists them in assignment order.
- **The matcher has one declared parameter.** At runtime it also receives the export key as a second argument, but the public type is `(fileName: string) => string`, so a two-parameter matcher does not compile.
- **A non-`AsyncService` instance is not awaited.** If `DI.resolve()` returns a `Promise` for it, `instance` holds that `Promise`.
- **`@NewInstance()` classes are built once per scan, not per read.** The scan's `Promise` is cached, so later reads return the same instances.
- **The `AsyncService` check uses `instanceof`.** A class extending `AsyncService` from a second copy of `@spinajs/di` is resolved without awaiting.

## Best practices

- Name scanned files after their class, and use a matcher when the convention differs from "first export".
- Make a scanned class an `AsyncService` when it needs I/O at start-up; `@ResolveFromFiles` then returns it ready.
- In a matcher, check `report.type` before use; a file that breaks the convention gives `type: undefined`.

## Patterns and antipatterns

```ts
// Don't: the DTO is the first export, so the scan picks InvoiceRow instead of the job
export class InvoiceRow { public Number!: string; }
export class MonthlyInvoicesJob extends ImportJob { /* ... */ }

// Do: move the DTO to its own module, or pass a typeMatcher that names the job
export class MonthlyInvoicesJob extends ImportJob { /* ... */ }
```

## Related

- [Loading classes from directories](01-loading-classes-from-directories.md): the scan these rules apply to.
- [Lifetimes](../di/04-lifetimes.md): `@Singleton`, `@NewInstance`, `@PerChildInstance`.
- [Service lifecycle](../di/10-service-lifecycle.md): `AsyncService.resolve()`.
- [Controller discovery](../http/03-controller-discovery.md): re-reads each scanned file to find every controller, not only the first export.
