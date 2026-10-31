# Config files

`JsFileSource` loads `.js` and `.cjs` config modules; `JsonFileSource` loads `.json` files. Both search the same list of directories: your project, every installed `@spinajs` package, the app directories and your custom paths. Both extend `BaseFileSource`, which you subclass to read another file format.

## How it works

1. **Construction.** `FrameworkConfiguration.loadSources()` resolves each source with `[RunApp, CustomConfigPaths, AppBaseDir, Env]`. The `BaseFileSource` constructor:
   1. sets `process.env.WORKSPACE_ROOT_PATH` to the nearest ancestor of the working directory whose `node_modules/@spinajs` is not empty, up to the workspace root, when the variable is unset;
   2. builds `CommonDirs`, the search list below;
   3. sets `BasePath` to the nearest ancestor of the working directory that has a `node_modules` folder, or the working directory itself.
2. **`LoadLayers(configuration)`** reads the environment with `getEnvironment(configuration)` (see [Environments](02-environments.md)), then calls `loadLayers()` with two passes:
   1. common files: `**/!(*.*).{cjs,js}` or `**/!(*.*).json`, file names with no dot before the extension;
   2. environment files: `**/*.<env>.{cjs,js}` or `**/*.<env>.json`.
3. **`loadLayers(extensions, callback)`** resolves relative directories against `BasePath`, globs each directory recursively, removes duplicate paths, runs `callback` on each file in parallel and deep-merges the results in directory order. A module's `default` export is used when present. `configFiles()` tags each file: a package config file goes to the `packages` layer and concatenates its arrays, any other file goes to the `app` layer and replaces them (see [Arrays](01-configuration-service.md#arrays)).
4. **Per file.** `JsFileSource` imports the module with `DI.__spinajs_require__()`, calls its `onConfigLoad(cfg)` when it exports one and uses the returned object. `JsonFileSource` reads and parses the file. Both add `__file__: [path]` to every top-level object.
5. The configuration joins the `packages` layers of the file sources next to each other, whatever the format, merges that over the tree, then merges each `app` layer on top. `Load(configuration)` gives one source's layers merged, for `mergeSource()`.

A file that fails to import or parse is logged with `InternalLogger.error` and counts as `{}`. The boot goes on.

## Search directories

In merge order within a [layer](01-configuration-service.md#arrays); rows 1 and 2 are the package layer, the others the app layer. Later directories win for scalars, and every app file wins over every package file:

| # | Directory | When |
| --- | --- | --- |
| 1 | `<dir>/node_modules/@spinajs/*/lib/config` for every ancestor `<dir>` of the working directory that has `node_modules`, nearest first, up to the workspace root | always |
| 2 | `<WORKSPACE_ROOT_PATH>/node_modules/@spinajs/*/lib/config` | when `WORKSPACE_ROOT_PATH` is set or detected |
| 3 | `<cwd>/src/config` | always |
| 4 | `<cwd>/lib/config`, `<cwd>/dist/config`, `<cwd>/build/config`, `<cwd>/config` | always |
| 5 | `<appBaseDir>/<app>/config` | when `app` and `appBaseDir` are set |
| 6 | `<cwd>/apps/<app>/config`, `<cwd>/dist/apps/<app>/config`, `<cwd>/lib/apps/<app>/config`, `<cwd>/build/apps/<app>/config` | when `app` is set |
| 7 | each `cfgCustomPaths` entry; relative ones resolve against `BasePath` | when set |

The workspace root is the nearest ancestor, the working directory included, whose `package.json` declares `workspaces` or that holds a `pnpm-workspace.yaml`. Directories above it belong to another project and are not searched, so a checkout nested in another one (a git worktree inside the main checkout) does not load the outer checkout's packages. Without a workspace root the search goes up to the filesystem root.

A directory that does not exist is skipped. A file reached through more than one directory (a workspace package is also reached through its `node_modules` symlink) loads once, at the last place it is reached.

## With a manifest

When the effective `system.manifest.mode` is `prefer` or `require` and a manifest is loaded (see [the manifest runtime](../manifest/README.md#runtime)), rows 1 and 2 are replaced by the config files the manifest lists for each `@spinajs/*` package (`packages[].configFiles`), at the same position and in the same order the glob gives: packages installed in a nearer `node_modules` first, then by name. Every other row, the deduplication and the merge are unchanged, so the result is the configuration the `node_modules` walk gives.

The compiler lists every package of the app's installed dependency closure, transitive dependencies included (see [`locateFragments`](../compiler/README.md#the-fragment-contract)). The two modes still differ in these cases:

- **Installed but not depended on.** The walk loads every `@spinajs/*` package under `node_modules`, also one only another workspace member pulled in. The manifest lists only what the app's `dependencies`, `devDependencies`, `optionalDependencies` and installed `peerDependencies` reach. In a monorepo, where the root `node_modules/@spinajs` holds every workspace package, the walk loads far more than the app uses.
- **Listed but not installed.** The manifest lists what the build install held; the run-time install can hold less (`npm prune --omit=dev`, an absent optional peer). Such a package is skipped with a debug line, like the walk does. In `require` mode a missing direct `dependency` of the app is an error instead.
- **The same package at two levels.** The walk loads the config of both copies. The manifest lists the copy that resolves from the app root.
- **`onConfigLoad` and the switch.** The switch (see [One switch](../manifest/README.md#one-switch)) reads `system.manifest` from the app's own config files before any other file loads, and imports a JS file without running its `onConfigLoad`. A `system.manifest` that only the hook returns does not turn the manifest on or off; set it in the exported object or in `SPINAJS_MANIFEST_MODE`. The file sources later load the same files with the hook, as without a manifest.
- **Hoisting-root detection still walks.** With `WORKSPACE_ROOT_PATH` unset, the `WORKSPACE_ROOT_PATH` detection (step 1.1 under [How it works](#how-it-works)) runs in manifest mode too, before any config file is imported, so package configs build the same paths in both modes. It checks every ancestor up to the workspace root for `node_modules` and reads each `node_modules/@spinajs` until one is not empty. It does not glob the package config dirs. Set `WORKSPACE_ROOT_PATH` (in a container image, for example) to skip it.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `WORKSPACE_ROOT_PATH` (environment variable) | `string` | detected hoisting root | absolute path | Root of an npm / yarn workspace. Package configs build their own paths from it (`${WORKSPACE_ROOT_PATH ?? cwd}/node_modules/@spinajs/<pkg>/...`), with `packageLibDirs()`. An explicit value is never overwritten. |
| `--app`, `--apppath`, `cfgCustomPaths` | see [Configuration service](01-configuration-service.md#configuration) | | | Add directories 5 to 7. |

A config module is a plain object, as a default export or as CommonJS exports:

```js
// config/http.js
export default {
  http: {
    port: 8080,
    cors: { origins: ['https://app.example.com'] },
  },
};
```

```js
// config/http.cjs
module.exports.http = { port: 8080 };
```

A module may export `onConfigLoad`. It runs before the merge and returns the object to merge:

```js
// config/build.js
export default {
  build: { startedAt: null },
  async onConfigLoad(cfg) {
    return { ...cfg, build: { startedAt: new Date().toISOString() } };
  },
};
```

A package config points `system.dirs` at its own build with `packageLibDirs(pkg, sub)`. It returns two paths, `<root>/node_modules/<pkg>/lib/<sub>` and the same one directory up (for a process started from an app or build folder), where `<root>` is `WORKSPACE_ROOT_PATH`, else the working directory. Node only.

```ts
// src/config/my-package.ts
import { packageLibDirs } from '@spinajs/configuration';

export default {
  system: { dirs: { cli: packageLibDirs('@spinajs/my-package', 'cli') } },
};
```

`mergeConfig(target, source, arrays)` is the merge the sources use (`concat`, or `replace` except for the paths in `COMPOSED_CONFIG_ARRAYS`, which `isComposedConfigArray(path)` checks). `merge(to, from)` and `mergeArrays` are exported too: `merge` deep-merges in place and unions arrays; `mergeArrays` is a `_.mergeWith` customizer that concatenates arrays.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| JS file source | `ConfigurationSource`, singleton (`@Injectable(ConfigurationSource)`), `Order` 1 | `JsFileSource` | none | Subclass `BaseFileSource`; or remove it with `DI.unregister(JsFileSource)` before the configuration resolves. |
| JSON file source | `ConfigurationSource`, singleton (`@Injectable(ConfigurationSource)`), `Order` 1 | `JsonFileSource` | none | Same as above. |
| File source base | abstract class `BaseFileSource` | none | `JsFileSource`, `JsonFileSource` | Extend it for another format; override `Order` and `getEnvironment()` as needed. |
| Module loader | `__module_loader__` DI value, read by `DI.__spinajs_require__()` | `import()` | any `{ load(path) }` | Register to load config modules in a bundled build. See [`@spinajs/di`](../di/README.md). |

### BaseFileSource: custom file format

Subclass `BaseFileSource` to load a format the framework does not read: YAML, TOML, `.env` files. You get the full search list and the environment handling; you write only the parser.

| Member | Kind | Use |
| --- | --- | --- |
| `Load(configuration)` | abstract, from `ConfigurationSource` | Call `this.load()` for the common and the environment pattern, merge the two. |
| `LoadLayers(configuration)` | optional | Return `this.loadLayers([common, env], callback)` to join the file sources' layers, so the package files of your format stay below the app. A source without it merges as a plain source, in `Order`. |
| `load(extension, callback)` | protected | Globs `extension` under every search directory into one tree; `callback(file)` returns a promise of the parsed object. |
| `loadLayers(extensions, callback)` | protected | The same for several passes, keeping the `packages` and `app` layers apart. |
| `getEnvironment(configuration)` | protected | Returns the normalized environment name. |
| `Order` | getter, `1` | Override to load before or after the other sources. |
| `CommonDirs`, `BasePath` | protected fields | Read or extend the search list in your constructor, or override the `CommonDirs` getter. Without a manifest, a directory that is a package config dir counts as a package, any other as the app. |

Register the subclass under `ConfigurationSource` before the configuration resolves. A constructor you add must accept the four source arguments (`RunApp`, `CustomConfigPaths`, `appBaseDir`, `Env`) and pass them to `super`.

```ts sample
import { readFileSync } from 'fs';
import { basename } from 'path';
import { DI, Injectable } from '@spinajs/di';
import { BaseFileSource, Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration';

/** Loads `KEY=value` files: `config/mail.env` becomes `{ mail: { KEY: 'value' } }`. */
@Injectable(ConfigurationSource)
class DotEnvFileSource extends BaseFileSource {
  // after JsFileSource and JsonFileSource, so .env values win
  public get Order() {
    return 2;
  }

  public async Load(configuration: Configuration): Promise<IConfigLike> {
    const env = this.getEnvironment(configuration);
    const parse = (file: string) => {
      const section = basename(file).split('.')[0];
      const values: Record<string, string> = {};
      for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (match) values[match[1]] = match[2];
      }
      const result: Record<string, unknown> = { [section]: values };
      return Promise.resolve(result as IConfigLike);
    };

    const common: Record<string, unknown> = await this.load('!(*.*).env', parse);
    const specific: Record<string, unknown> = await this.load(`*.${env}.env`, parse);
    for (const [section, values] of Object.entries(specific)) {
      common[section] = { ...(common[section] as object), ...(values as object) };
    }
    return common as IConfigLike;
  }
}

async function main() {
  // config/mail.env holds SMTP_HOST=smtp.example.com
  const configuration = await DI.resolve(Configuration);
  console.log(configuration.get<string>('mail.SMTP_HOST'));
}

void main();
```

`@Injectable(ConfigurationSource)` registers the class when its module is imported. Import the module before the first `DI.resolve(Configuration)`.

## Important behaviour

- Files load in two passes: every common file, then every environment file, once for the package layer and once for the app layer. A common file in your project wins over an environment file in a package directory.
- A file whose name has a dot before the extension (`my.settings.js`) is not a common file. It loads only when the environment is named after its second part (`settings`).
- Directories are globbed recursively: `config/nested/db.js` loads like `config/db.js`. The directory structure does not change the config keys; only the exported object does.
- A config module that throws on import, or a JSON file with a syntax error, is logged and skipped. The configuration boots without it, and a schema may then fill defaults for the missing module.
- `WORKSPACE_ROOT_PATH` is detected once per source construction and written to `process.env`. In a workspace, without it, package configs build paths under the app package that do not exist.
- The ancestor walk (row 1 and the `WORKSPACE_ROOT_PATH` detection) stops at the workspace root, but an explicit `WORKSPACE_ROOT_PATH` is searched wherever it points (row 2). In a nested checkout, leave it unset or point it at the inner checkout, or the outer packages load again.
- A project with neither `workspaces` nor `pnpm-workspace.yaml` walks up to the filesystem root. Inside another project's tree it loads that project's `@spinajs` package configs; add a `pnpm-workspace.yaml` or a `workspaces` entry to stop the walk.
- The sources are singletons: the constructor arguments (`app`, paths, `Env`) are read when a source is first resolved in a container.
- A `.js` config module runs as code at boot. Keep it free of side effects other than building the object; put setup in a [`configure()` hook](01-configuration-service.md#configure-hooks).

## Best practices

- Put shared values in `config/<module>.js` and per-environment values in `config/<module>.<env>.js`; one top-level key per file, named like the file.
- Keep secrets out of files: use a protocol string such as `aws-secrets://...` (see [Config var protocols](05-config-var-protocols.md)) or `process.env`.
- In tests, point `cfgCustomPaths` at a fixtures directory instead of changing the working directory.

## Patterns and antipatterns

```js
// Don't: list only the entry you add; the app's array replaces the package's, so the package's 'en' is gone
export default { intl: { locales: ['pl'] } };

// Do: list the whole array
export default { intl: { locales: ['en', 'pl'] } };
```

## Examples

### Load configs from a deployment directory in tests

```ts sample
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

async function main() {
  const configuration = await DI.resolve(Configuration, [
    { cfgCustomPaths: [join(process.cwd(), 'test', 'fixtures', 'config')] },
  ]);

  console.log(configuration.get('db.DefaultConnection'));
}

void main();
```

## Related

- [Environments](02-environments.md): what `<env>` is.
- [Custom configuration sources](04-custom-configuration-sources.md): sources that do not read files.
- [Configuration service](01-configuration-service.md): merge rules and the boot order.
