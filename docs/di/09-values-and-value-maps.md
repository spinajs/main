# Values and value maps

`asValue` and `asMapValue` put a ready object into the container instead of a class to build. Use them for settings objects, shared registries, already constructed third-party clients, and lookup tables keyed by name.

## How it works

### `asValue(key, override = false)`

1. `DI.register(value).asValue('key')` stores `value` under `key` among the registry's **values**, apart from the class registrations. Values are registrations, so `clearCache()` keeps them.
2. Several values under one key are kept in order. With `override = true`, the existing values and any instance cached under `key` in that container are removed first.
3. The binder emits `di.registered.<key>`.
4. Read the value with `DI.get('key')` (the last one) or `DI.get(Array.ofType('key'))` (all of them). Children see the parent's values, because `get()` looks in ancestors by default.

### `asMapValue(key, hashKey)`

1. `DI.register(value).asMapValue('key', 'hashKey')` finds the `Map` stored under `key`, creating it on the first call.
2. It sets `map.set(hashKey, value)`; the same `hashKey` again overwrites.
3. Read it with `DI.get<Map<string, T>>('key')` and look up by `hashKey` in O(1).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| A value under a string key | The string; stays until `uncache`, `clearRegistry` or `clear`; `clearCache` and `dispose` keep it | Whatever the package stores | Your object | `DI.register(obj).asValue('key', true)` replaces every earlier value; without `true` it adds one |
| A value map, eg. `'__file_provider_instance__'` (`@spinajs/fs`), `'__http_error_map__'` (`@spinajs/http`), `'__orm_db_value_converters__'` (`@spinajs/orm`) | The string; one stored `Map` | Entries the package adds | Your entry | `container.register(obj).asMapValue('key', 'hashKey')` adds or replaces one entry |
| `'__module_loader__'` and `'__esmMode__'` | String values read by `DI.__spinajs_require__` | none / `{ mjs: true }` after `DI.setESMModuleSupport()` | Your `IModuleLoader` | See [Module loading](13-module-loading.md) |

### Adding an entry to a value map

Register under the map's key with your hash key. The consumer reads the map when it needs it, so add entries before that.

```ts sample
import { DI } from '@spinajs/di';

type ExportFormat = {
  mime: string;
  render(rows: string[][]): string;
};

const csv: ExportFormat = { mime: 'text/csv', render: (rows) => rows.map((r) => r.join(',')).join('\n') };
const tsv: ExportFormat = { mime: 'text/tab-separated-values', render: (rows) => rows.map((r) => r.join('\t')).join('\n') };

DI.register(csv).asMapValue('__export_formats__', 'csv');
DI.register(tsv).asMapValue('__export_formats__', 'tsv');

function exportRows(format: string, rows: string[][]) {
  const formats = DI.get<Map<string, ExportFormat>>('__export_formats__');
  const f = formats?.get(format);
  if (!f) {
    throw new Error(`unknown format ${format}, known: ${[...(formats?.keys() ?? [])].join(', ')}`);
  }
  return { mime: f.mime, body: f.render(rows) };
}

console.log(exportRows('tsv', [['id', 'name'], ['1', 'Ann']]));
```

## Important behaviour

- Values are not class registrations. `DI.check('key')` and `hasRegistered('key')` return `false` for them, and `DI.resolve('key')` returns `null`. Read them with `DI.get()`; `DI.has('key')` (`isResolved`) is `true` for them.
- `DI.clearRegistry()`, `DI.clear()` and `DI.uncache('key')` remove values and value maps; `DI.clearCache()` and `DI.dispose()` keep them. A value registered at import time ( eg. a configuration schema ) survives a test's `clearCache()`.
- A value that is a `Service` (eg. an `AsyncService` built outside DI) is disposed by `dispose()` like any cached service, and stays registered.
- `register()` rejects falsy values: `0`, `''`, `false` and `null` throw `InvalidArgument`. Wrap them in an object.
- The value is stored by reference. Mutating it later changes what every reader sees.

## Best practices

- Prefix internal keys with `__` and suffix them with their purpose, as the shipped packages do (`'__http_error_map__'`), so they do not collide with class names.
- Prefer `asMapValue` over many `asValue` entries when consumers look values up by name.
- For anything with dependencies or a lifecycle, register a class instead; values are not injected and not initialized.

## Patterns and antipatterns

```ts
// Don't: values are not registry entries, so this is always false and resolve() is null
if (DI.check('app.settings')) {
  DI.resolve('app.settings');
}

// Do
const settings = DI.get<AppSettings>('app.settings');
```

## Examples

### Share one feature-flag object with every container

```ts sample
import { DI } from '@spinajs/di';

type FeatureFlags = {
  newCheckout: boolean;
};

DI.register({ newCheckout: false } as FeatureFlags).asValue('app.flags');

// A deployment overrides the flags; `true` drops the earlier value.
DI.register({ newCheckout: true } as FeatureFlags).asValue('app.flags', true);

const tenant = DI.child();
console.log(tenant.get<FeatureFlags>('app.flags')?.newCheckout, DI.get(Array.ofType<FeatureFlags>('app.flags'))?.length);
// true 1
```

## Related

- [Registering services](01-registering-services.md): the other `IBind` methods.
- [Module loading](13-module-loading.md): the `'__module_loader__'` and `'__esmMode__'` values.
- [Container events](12-container-events.md): `di.registered.<key>` on value registration.
