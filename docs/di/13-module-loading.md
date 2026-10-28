# Module loading

`DI.__spinajs_require__(path)` is the one place where SpinaJS loads a module by file path at runtime: configuration files, controllers, migrations, translations, classes found by `@spinajs/reflection`. It uses `import()`, or delegates to a loader you register, which is how bundled and browser builds load modules without a file system.

## How it works

1. `DI.__spinajs_require__(module)` reads `DI.get('__module_loader__')`. When a loader is registered, it returns `loader.load(module)` and stops.
2. Otherwise it calls `import()` on the path (converted to a `file://` URL unless it already is one) and returns the module's `default` export, or the module namespace when there is none.

## API

| Member | Meaning |
| --- | --- |
| `DI.__spinajs_require__(module: string): Promise<unknown>` | Loads a module by path or URL |
| `DI.setESMModuleSupport()` | Deprecated no-op since 4.0 (emits one `DeprecationWarning`); still registers `{ mjs: true }` as `'__esmMode__'`. Removed in 5.0 |
| `DI.IModuleLoader` | `{ load(module: string): Promise<unknown> }`; exported inside the `DI` namespace only |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DI.IModuleLoader` | The value `'__module_loader__'` in the root container; read on every load | none: `import()` | Your loader | `DI.register(loader).asValue('__module_loader__')` before anything loads modules, eg. before the bootstrappers run |

### A custom module loader

Register a loader when modules cannot be loaded from disk: a bundle that maps paths to pre-imported modules, a browser build, a test that serves fixtures from memory. The loader receives the exact string the caller passed (a path or a `file://` URL) and returns what `require` would.

```ts sample
import { DI } from '@spinajs/di';

// Modules the bundler imported statically, keyed by the path the framework asks for.
const bundled: Record<string, unknown> = {
  '/app/config/app.js': { default: { app: { name: 'billing' } } },
};

class BundleLoader implements DI.IModuleLoader {
  public async load(module: string): Promise<unknown> {
    const key = module.replace(/^file:\/\//, '');
    if (!(key in bundled)) {
      throw new Error(`module ${key} is not in the bundle`);
    }
    return bundled[key];
  }
}

DI.register(new BundleLoader()).asValue('__module_loader__');

async function main() {
  const config = await DI.__spinajs_require__('/app/config/app.js');
  console.log(config);
  // { default: { app: { name: 'billing' } } }
}

void main();
```

## Important behaviour

- The loader is read from the **root** container on every call; registering it in a child has no effect.
- A registered loader takes over completely: `import()` is not used, and the loader's result is returned as is, without unwrapping `default`.
- `default` is unwrapped; a module without a default export returns its namespace object.
- The loader is a value: `DI.clear()`, `DI.clearRegistry()` and `DI.uncache('__module_loader__')` remove it, `DI.clearCache()` and `DI.dispose()` keep it.

## Best practices

- Do not call `DI.setESMModuleSupport()` in new code; it does nothing useful since 4.0.
- Make a custom loader accept both plain paths and `file://` URLs; callers in the framework pass both.

## Related

- [Values and value maps](09-values-and-value-maps.md): how `'__module_loader__'` is stored.
- [`@spinajs/reflection`](../reflection/README.md): loads classes from directories through this function.
- [`@spinajs/configuration`](../configuration/README.md): loads configuration files through this function.
