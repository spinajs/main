# createTestApp

`createTestApp(options)` registers a Configuration, runs every registered `Bootstrapper`, resolves `Configuration` and the services in `options.resolve`, and returns a `TestApp` whose `dispose()` undoes all of it.

## Options

| Option | Meaning |
| --- | --- |
| `config` | Plain object; it is the whole configuration, no files are read, every registered schema validates it. |
| `configuration` | A `FrameworkConfiguration` subclass instead of `config`. |
| `schemas` | Extra `IConfigurationSchema` objects registered before Configuration resolves. |
| `register` | `(container) => void`; registrations applied before anything resolves. |
| `resolve` | Classes or tokens resolved after Configuration. |
| `env` | Stands in for `APP_ENV`; default `test`. |
| `scope` | `root` (default) or `child`, see below. |
| `bootstrap` | Run bootstrappers; default `true`. |

## Scopes

`root` snapshots the root container, boots in it and restores the snapshot on `dispose()`: registrations, values, cached singletons and event listeners added since the snapshot are removed, and every `Service` created since is disposed in reverse order. Disposal runs before the swap back, so a `dispose()` still reads the app's `@Config` values and injections. Use it for packages whose code calls the static `DI` API (`DI.resolve`, `DI.get`), such as `@spinajs/http`. Only one root app can be live at a time: `createTestApp` rejects with "a root app is already live; dispose it first, or use scope 'child' for apps side by side".

`child` boots in `DI.child({ isolateSingletons: true })`: the child owns every singleton it resolves, even ones registered in root, and `dispose()` disposes the child. Several child apps can be live at once. Use it for code that only uses the injected container, such as configuration-schema tests.

Set `SPINAJS_TEST_STRICT=1` to make a root-scope `dispose()` throw when the root cache size differs from the size before the boot.

## `useTestApp`

```ts sample
import { useTestApp } from '@spinajs/testing';

describe('suite', () => {
  const app = useTestApp(() => ({ config: { app: { name: 'spec' } } }));
  it('has a fresh app per test', () => {
    app().config.set('app.name', 'changed');
  });
});
```

## Configuration helpers

- `configurationViolations({ schemas, config })` boots in a child and returns the violation paths, `[]` on success.
- `readingFrom(instance, container)` binds the `@Config` properties of a `new`-ed instance to a container.
- `fakeContainer({ 'a.b': 1 })` answers `@Config` reads by full path without validation.
- `setPastSchema(configuration, 'a.b', value)` writes without the schema check.
- `disposeTestApps()` disposes every app that is still live, in reverse creation order.
