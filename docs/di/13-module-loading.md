# Module loading

`DI.__spinajs_require__(path)` is the one place where SpinaJS loads a module by file path at runtime: configuration files, controllers, migrations, translations, classes found by `@spinajs/reflection`. It uses `require` or `import()` depending on the module mode, or delegates to a loader you register, which is how bundled and browser builds load modules without a file system.

## How it works

1. `DI.__spinajs_require__(module)` reads `DI.get('__module_loader__')`. When a loader is registered, it returns `loader.load(module)` and stops.
2. Otherwise it reads `DI.get('__esmMode__')`. When `mjs` is `true` (after `DI.setESMModuleSupport()`), it calls `import()` on the path, prefixing `file://` unless the path already has it, and returns the module's `default` export, or the module namespace when there is none.
3. Otherwise it calls `require(module)`. Without `require` (a bundled or browser build) it throws an `Error` that names both fixes: register a loader, or enable ESM mode.

## API

| Member | Meaning |
| --- | --- |
| `DI.__spinajs_require__(module: string): Promise<unknown>` | Loads a module by path or URL |
| `DI.setESMModuleSupport()` | Registers `{ mjs: true }` as the value `'__esmMode__'`, switching to `import()` |
| `DI.IModuleLoader` | `{ load(module: string): Promise<unknown> }`; exported inside the `DI` namespace only |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DI.IModuleLoader` | The value `'__module_loader__'` in the root cache; read on every load | none: `require` or `import()` | Your loader | `DI.register(loader).asValue('__module_loader__')` before anything loads modules, eg. before the bootstrappers run |
| ESM mode | The value `'__esmMode__'` | Not set (CommonJS `require`) | `{ mjs: true }` | `DI.setESMModuleSupport()` at the top of an ESM entry, as `@spinajs/cli` does |

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

- The loader and the ESM flag are read from the **root** container on every call; registering them in a child has no effect.
- A registered loader takes over completely: ESM mode is ignored, and the loader's result is returned as is, without unwrapping `default`.
- In ESM mode, `default` is unwrapped; a module without a default export returns its namespace object.
- `DI.clear()`, `DI.clearCache()` and `DI.dispose()` remove both values, since they live in the cache. Register them again after clearing in tests.

## Best practices

- Call `DI.setESMModuleSupport()` once, first thing in an ESM entry file, before configuration or reflection load anything.
- Make a custom loader accept both plain paths and `file://` URLs; callers in the framework pass both.

## Related

- [Values and value maps](09-values-and-value-maps.md): how `'__module_loader__'` and `'__esmMode__'` are stored.
- [`@spinajs/reflection`](../reflection/README.md): loads classes from directories through this function.
- [`@spinajs/configuration`](../configuration/README.md): loads configuration files through this function.
