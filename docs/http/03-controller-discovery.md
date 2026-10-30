# Controller discovery

`ControllerSource` services tell the `Controllers` loader which controller classes exist. Two ship with the package: a directory scan and a DI registry reader. Add your own to mount controllers from a plugin manifest, behind a feature flag, or from a remote registry. `Controllers.add()` mounts one more controller after startup.

## How it works

1. `Controllers.getSources()` resolves `Array.ofType(ControllerSource)`: every class registered with `@Injectable(ControllerSource)`.
2. `Controllers.listControllers()` calls `getControllers()` on every source in parallel and flattens the results. Each entry is a `ClassInfo<BaseController>`: `name`, `type` and `file`.
3. It deduplicates by `type`. When two sources list the same class, the entry whose `file` is a real path wins over a sentinel such as `<di>` or `<dynamic>`; the cache needs the file to read parameter names and JSDoc.
4. Entries without a `type` are kept, logged as a warning in `Controllers.resolve()`, and skipped.
5. `Controllers.resolve()` registers each type as `BaseController` and resolves them all; see [Controllers and routing](02-controllers-and-routing.md#how-it-works).

Sources only **discover**. They never create controller instances; DI does that in one pass.

### `FilesystemControllerSource`

1. `@ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')` lists every `.ts` and `.js` file (not `.d.ts`) under each directory in `system.dirs.controllers`.
2. The scan returns one entry per exported class of each file. A default-exported class counts as one export.
3. An export is a controller when its prototype extends `BaseController` or carries the route descriptor (`CONTROLLED_DESCRIPTOR_SYMBOL`). DTO classes and helpers in the same file are skipped; several controllers in one file are all found.

### `ManifestControllerSource`

1. It reads the effective manifest mode and manifest from `effectiveManifestOf(container)`. In `off` mode, or `prefer` without a registered manifest, it returns nothing; `require` without a manifest throws `ManifestMissing`.
2. Otherwise it returns the classes the manifest lists in `controllers`, re-sorted the way the directory scan orders files (`glob`'s locale-aware sort, not the compiler's code-unit order), so routes register in the same order in both modes. The manifest lists the controllers discovery finds: for the app, the ones under the `system.dirs.controllers` of its build (see [The app's own classes](../manifest/README.md#the-apps-own-classes)), and for each package, the ones under the dirs that package's config declares. An abstract base, or a controller another source mounts (authz-http's explain route) is not listed. Each file goes through `manifestFileFor` (root containment and hash), and entries of a listed package that is not installed are skipped.
3. The same filter as the directory scan applies: only `BaseController` subclasses and classes with the route descriptor are kept.
4. In `require` mode `FilesystemControllerSource` returns nothing and never scans, so the manifest is the only file-backed source. In `prefer` mode both lists merge and the loader deduplicates by type.

### `DiRegistryControllerSource`

1. It reads `DI.getRegisteredTypes(BaseController)`: every class registered with `DI.register(X).as(BaseController)` before `Controllers` resolves, typically by a package `Bootstrapper`.
2. The `file` of each entry is the `SourceFile` the route decorators captured at import, or `<di>` when no route decorator ran.

### Adding a controller at runtime

`Controllers.add(type)` mounts a controller after startup:

1. It returns at once when the type is already mounted.
2. It registers the type as `BaseController`, resolves it, and runs `Controllers.register()`.
3. The new router joins the shared controllers router, which already sits at a fixed place in the Express stack, so the new routes answer at once and stay before the 404 handler.
4. When anything fails, it unregisters the type and drops the cached `BaseController` list, then rethrows; a fixed retry registers cleanly.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.controllers` | `string[]` | not set | absolute directories | Directories `FilesystemControllerSource` scans, recursively. |

```ts
export default {
  system: {
    dirs: {
      // Point at the compiled output in production; .d.ts files beside it feed the controller cache.
      controllers: ['/app/dist/controllers'],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ControllerSource` | Abstract class `ControllerSource` (an `AsyncService`); list `Array.ofType(ControllerSource)`, each a singleton; resolved by `Controllers.getSources()` and by the `http:controllers:cache` command | `FilesystemControllerSource`, `DiRegistryControllerSource` | `ExplainControllerSource` in `@spinajs/authz-http` (mounts a debug controller outside production only) | Add one with `@Injectable(ControllerSource)`. Remove one with `DI.unregister(FilesystemControllerSource)` before `Controllers` resolves, or override `Controllers.getSources()`. |
| Registered controller | `BaseController` list | none | any class | `DI.register(MyController).as(BaseController)` in a `Bootstrapper`, before `Controllers` resolves. |

### `ControllerSource`: custom implementation

Implement `getControllers()` and return one `ClassInfo` per controller. Set `file` to the controller's source file so the [controller cache](21-controller-cache-and-cli.md) can read parameter names and JSDoc; take it from the descriptor the route decorators wrote. Register the source before `Controllers` resolves.

```ts sample
import { ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BaseController, BasePath, CONTROLLED_DESCRIPTOR_SYMBOL, ControllerSource, Get, Ok } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

@BasePath('reports')
export class ReportsController extends BaseController {
  @Get('monthly')
  public monthly() {
    return new Ok({ month: '2026-09', revenue: 1200 });
  }
}

@BasePath('beta')
export class BetaController extends BaseController {
  @Get('search')
  public search() {
    return new Ok({ engine: 'vector' });
  }
}

/** Mounts each controller only when its feature flag is on in configuration. */
@Injectable(ControllerSource)
export class FeatureFlagControllerSource extends ControllerSource {
  @Config('features', { defaultValue: {} })
  protected Features: Record<string, boolean>;

  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    const byFlag: Record<string, typeof BaseController> = {
      reports: ReportsController,
      beta: BetaController,
    };

    return Object.entries(byFlag)
      .filter(([flag]) => this.Features[flag] === true)
      .map(([, type]) => {
        const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, type.prototype) as IControllerDescriptor | undefined;
        const ci = new ClassInfo<BaseController>();
        ci.name = type.name;
        ci.type = type as any;
        ci.file = descriptor?.SourceFile ?? '<di>';
        return ci;
      });
  }
}
```

Keep these controllers out of `system.dirs.controllers`, or the directory scan mounts them regardless of the flag.

## Important behaviour

- A source with an empty or missing `system.dirs.controllers` lists nothing; that is not an error.
- `FilesystemControllerSource` imports every file it lists. Importing a controller file runs its decorators and registers anything it declares with `@Injectable`.
- A controller listed only as `<di>` or `<dynamic>` gets parameter names from `Function.prototype.toString()` and no JSDoc documentation.
- `Controllers.Controllers` (a `Promise` of the merged list) is computed once and cached; `@spinajs/http-swagger` reads it. Controllers added later with `add()` are not in it.
- The `http:controllers:cache` command uses the same sources; see [Controller cache and CLI](21-controller-cache-and-cli.md).

## Best practices

- Register package controllers from a `Bootstrapper` with `DI.register(MyController).as(BaseController)`, so the app does not need to list the package's directory.
- Keep a controller whose mounting depends on configuration out of the scanned directories and hand it in through a source, as `@spinajs/authz-http` does for its explain route.
- Ship the `.d.ts` files next to the compiled controllers; the cache parses them.

## Patterns and antipatterns

```ts
// Don't: a source that builds instances; Controllers resolves types itself and the instance is ignored.
public async getControllers() {
  const ci = new ClassInfo<BaseController>();
  ci.instance = await DI.resolve(ReportsController);
  return [ci];
}

// Do: return the type and its source file.
public async getControllers() {
  const ci = new ClassInfo<BaseController>();
  ci.name = ReportsController.name;
  ci.type = ReportsController;
  ci.file = descriptor?.SourceFile ?? '<di>';
  return [ci];
}
```

## Examples

### Mount a plugin controller after startup

```ts sample
import { DI } from '@spinajs/di';
import { BaseController, BasePath, Controllers, Get, Ok } from '@spinajs/http';

@BasePath('plugins/weather')
export class WeatherPluginController extends BaseController {
  @Get('today')
  public today() {
    return new Ok({ city: 'Gdansk', celsius: 14 });
  }
}

export async function enableWeatherPlugin() {
  const controllers = await DI.resolve(Controllers);

  // Idempotent: a second call does nothing. GET /plugins/weather/today answers at once.
  await controllers.add(WeatherPluginController);
}
```

## Related

- [Controllers and routing](02-controllers-and-routing.md): what happens to the listed controllers.
- [Controller cache and CLI](21-controller-cache-and-cli.md): why `file` matters.
- [`@spinajs/reflection`](../reflection/README.md): `@ListFromFiles`, used by the directory scan.
- [`@spinajs/di`](../di/README.md): `Array.ofType`, `ClassInfo` and `Bootstrapper`.
