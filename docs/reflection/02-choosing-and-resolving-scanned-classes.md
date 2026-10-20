# Choosing and resolving scanned classes

A scan builds one `ClassInfo` per exported class of each file. Two things decide what it holds: the `typeMatcher` you pass, which can narrow the exports to one, and the scanned class's own DI setup, which decides what `@ResolveFromFiles` puts in `instance`.

## How it works

1. **Export keys.** For each imported module, the scan walks every key of `Object.keys(module)`.
2. **Export name.** With a `typeMatcher`, the name is `typeMatcher(path.parse(file).name, key)`: the file's base name without its last extension, and the export key; see [Type matcher](#type-matcher). Without one, the name is the key.
3. **Type.** `type` is `module[name]`. A value without a prototype (a constant, an arrow function, a missing export) is skipped, and so is a class already taken for this file under another name.
4. **List mode.** `@ListFromFiles` adds `{ file, name, type, instance: undefined }` and moves to the next key.
5. **Resolve mode.** `@ResolveFromFiles` checks `type.prototype instanceof AsyncService`:
   - `AsyncService`: it awaits `DI.resolve(type)`, which runs `resolve()` on a new instance, and stores the result.
   - Any other class: it stores the value `DI.resolve(type)` returns, without awaiting it.
6. **Lifetime.** `DI.resolve(type)` honours the class's lifetime decorator. Without one, the class is a singleton in the root container.
7. **Errors.** A synchronous resolve error or a rejected `AsyncService.resolve()` is logged at `error`, and that class yields no entry. The other classes of the file are still resolved.

### Type matcher

`path.parse(file).name` strips only the last extension:

| File | `fileName` passed to the matcher |
| --- | --- |
| `jobs/monthly-invoices.js` | `monthly-invoices` |
| `jobs/MonthlyInvoices.ts` | `MonthlyInvoices` |
| `jobs/monthly-invoices.job.js` | `monthly-invoices.job` |

The matcher returns the export name to use. A matcher that ignores the export key names one class per file, which is then listed once. A name that is not exported yields no entry.

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
| Export picker | The `typeMatcher` argument of the decorator | Every exported class | Any `(fileName: string, exportKey: string) => string` | Pass a function; see [Type matcher: custom implementation](#type-matcher-custom-implementation) |
| Scanned class | The class itself, by type, root container | Singleton | `@NewInstance()`, `@PerChildInstance()`, `AsyncService` | Decorate the scanned class, or `DI.register(Impl).as(Scanned)` before the first read |

### Type matcher: custom implementation

Pass a matcher when a scanned file exports more than one class and you want only one of them. A file that exports its DTOs next to the class is the common case. Derive the export name from the file name with a fixed convention.

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

- **A default-exported class is seen under its class name.** In ESM mode `DI.__spinajs_require__` unwraps a default export, so the named exports next to it are not seen.
- **Order depends on the module mode.** Entries of one file follow its export order: alphabetical for an ESM namespace object, assignment order for a CommonJS `exports` object.
- **The matcher is called once per export key.** It receives the file name and the export key; a one-parameter matcher returns the same name for every key.
- **A non-`AsyncService` instance is not awaited.** If `DI.resolve()` returns a `Promise` for it, `instance` holds that `Promise`.
- **`@NewInstance()` classes are built once per scan, not per read.** The scan's `Promise` is cached, so later reads return the same instances.
- **The `AsyncService` check uses `instanceof`.** A class extending `AsyncService` from a second copy of `@spinajs/di` is resolved without awaiting.

## Best practices

- Name scanned files after their class, and use a matcher when a file exports classes the scan should not list or resolve.
- Make a scanned class an `AsyncService` when it needs I/O at start-up; `@ResolveFromFiles` then returns it ready.
- With a matcher, a file that breaks the convention yields no entry, so a missing class shows up as a missing entry, not an error.

## Patterns and antipatterns

```ts
// Don't: @ResolveFromFiles resolves every exported class, so InvoiceRow becomes a DI singleton too
export class InvoiceRow { public Number!: string; }
export class MonthlyInvoicesJob extends ImportJob { /* ... */ }

// Do: move the DTO to its own module, or pass a typeMatcher that names the job
export class MonthlyInvoicesJob extends ImportJob { /* ... */ }
```

## Related

- [Loading classes from directories](01-loading-classes-from-directories.md): the scan these rules apply to.
- [Lifetimes](../di/04-lifetimes.md): `@Singleton`, `@NewInstance`, `@PerChildInstance`.
- [Service lifecycle](../di/10-service-lifecycle.md): `AsyncService.resolve()`.
- [Controller discovery](../http/03-controller-discovery.md): keeps the scanned classes that are controllers.
