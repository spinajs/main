# Named services

A named lookup picks one registration under a base class by its name: the class name, or the function name of a factory. Use it when configuration, a request or a CLI flag decides which implementation runs, eg. `'S3Storage'` versus `'LocalStorage'`.

## How it works

1. **Collect.** `container.getRegisteredNames(Base)` walks `Array.chainOf(Base)` (the container and all its ancestors, root first) and returns each registration's name once:
   - a class goes by its class name;
   - a factory goes by its function `name`; a factory with an empty name is left out.
2. **Find.** `container.resolveNamed(Base, name)` searches the same chain from the **nearest** container up and takes the first registration with that name.
3. **Build.**
   - A factory is called with the resolving container, and its result is returned as is, `undefined` included.
   - A class is resolved through DI in the container that registered it, so its lifetime applies. A `@PerChildInstance()` class is resolved in the resolving container.
4. **Result.** Always a `Promise`; an `AsyncService` is awaited before it resolves. No registration with that name: rejects with `ServiceNotFound('No <Base> is registered as "<name>"')`.

### Naming a factory

An inline arrow function has an empty name. Give a factory a name before registering it:

- assign it to a `const` first (`const s3 = (c) => ...` is named `s3`), or
- set it explicitly with `Object.defineProperty(factory, 'name', { value: 'S3Storage' })`.

## API

| Call | Returns | Notes |
| --- | --- | --- |
| `container.getRegisteredNames(Base)` | `string[]`, ancestors first, no repeats | Same lineage as `Array.chainOf(Base)` |
| `container.resolveNamed(Base, name)` | `Promise<T>` | Nearest container first; throws `ServiceNotFound` |
| `IMappableService` | `{ ServiceName: string }` | An instance-level name. `@AutoinjectService` in `@spinajs/configuration` keys injected maps by `ServiceName`, falling back to the class name |
| `IServiceFuncResult` | `{ service: string; options?: any }` | What a `serviceFunc` returns to name the service to inject; see [Custom injection decorators](11-custom-injection-decorators.md#selecting-a-service-by-name-servicefunc) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| A service picked by name | The base class; each registration keeps its lifetime (factories run on every lookup) | The registration whose name the caller asks for | Every class or named factory registered under the base, in any container of the lineage | Register another class or named factory under the base; override a name in a child by registering a registration with the same name there |
| Name-based injection from configuration | `@AutoinjectNamedService`, `resolveNamedService` in `@spinajs/configuration` | Built on `getRegisteredNames` and `resolveNamed` | none | See [`@spinajs/configuration`](../configuration/README.md) |

### Adding a selectable implementation

Register a class (its name is the selector) or a named factory under the base. A child container can register a registration with the same name to override it for one scope.

```ts sample
import { DI, IContainer } from '@spinajs/di';

abstract class FileStorage {
  public abstract url(path: string): string;
}

class LocalStorage extends FileStorage {
  public url(path: string) {
    return `file:///var/data/${path}`;
  }
}

class CdnStorage extends FileStorage {
  constructor(protected readonly host: string) {
    super();
  }

  public url(path: string) {
    return `https://${this.host}/${path}`;
  }
}

DI.register(LocalStorage).as(FileStorage);

// A factory is selectable by its function name.
const cdn = (_container: IContainer) => new CdnStorage('cdn.example.com');
Object.defineProperty(cdn, 'name', { value: 'CdnStorage' });
DI.register(cdn).as(FileStorage);

async function main() {
  const selected = process.env.STORAGE || 'CdnStorage';
  const names = DI.RootContainer.getRegisteredNames(FileStorage);
  if (!names.includes(selected)) {
    throw new Error(`STORAGE must be one of ${names.join(', ')}`);
  }

  const storage = await DI.RootContainer.resolveNamed(FileStorage, selected);
  console.log(storage.url('avatars/ann.png'));
  // https://cdn.example.com/avatars/ann.png
}

void main();
```

## Important behaviour

- `resolveNamed` looks at registration names, not at instances: `IMappableService.ServiceName` plays no part in it.
- A factory found by `resolveNamed` receives the **resolving** container; in `Array.chainOf` the same factory receives the container that registered it.
- A factory result is not cached: every `resolveNamed` of a factory name calls the factory again.
- Two registrations with the same name in one lineage: `getRegisteredNames` lists the name once, `resolveNamed` takes the one in the nearest container.

## Best practices

- Validate a configured name against `getRegisteredNames(Base)` at startup and list the valid names in the error, as `@spinajs/configuration` does.
- Name factories after the class they build, so the same selector works whether you register the class or a factory.

## Patterns and antipatterns

```ts
// Don't: an inline arrow has no name and can never be selected
DI.register(() => new CdnStorage('cdn.example.com')).as(FileStorage);
await container.resolveNamed(FileStorage, 'CdnStorage'); // ServiceNotFound

// Do
const cdn = () => new CdnStorage('cdn.example.com');
Object.defineProperty(cdn, 'name', { value: 'CdnStorage' });
DI.register(cdn).as(FileStorage);
```

## Examples

### Let a tenant use a different storage under the same name

```ts sample
import { DI } from '@spinajs/di';

abstract class FileStorage {
  public abstract url(path: string): string;
}

class LocalStorage extends FileStorage {
  public url(path: string) {
    return `file:///var/data/${path}`;
  }
}

DI.register(LocalStorage).as(FileStorage);

async function main() {
  const tenant = DI.child();
  const tenantLocal = () => ({ url: (path: string) => `file:///tenants/acme/${path}` });
  Object.defineProperty(tenantLocal, 'name', { value: 'LocalStorage' });
  tenant.register(tenantLocal).as(FileStorage);

  console.log((await tenant.resolveNamed(FileStorage, 'LocalStorage')).url('a.txt'));
  console.log((await DI.RootContainer.resolveNamed(FileStorage, 'LocalStorage')).url('a.txt'));
  // file:///tenants/acme/a.txt
  // file:///var/data/a.txt
}

void main();
```

## Related

- [Multiple implementations](06-multiple-implementations.md): the `Array.chainOf` lineage these lookups use.
- [Factories](08-factories.md): factory registrations and their arguments.
- [Custom injection decorators](11-custom-injection-decorators.md): `serviceFunc`, the older name-based injection hook.
- [`@spinajs/configuration`](../configuration/README.md): picks services by names stored in configuration.
