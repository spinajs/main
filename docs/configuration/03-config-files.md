# Config files

`JsFileSource` loads `.js` and `.cjs` config modules; `JsonFileSource` loads `.json` files. Both search the same list of directories: your project, every installed `@spinajs` package, the app directories and your custom paths. Both extend `BaseFileSource`, which you subclass to read another file format.

## How it works

1. **Construction.** `FrameworkConfiguration.loadSources()` resolves each source with `[RunApp, CustomConfigPaths, AppBaseDir, Env]`. The `BaseFileSource` constructor:
   1. sets `process.env.WORKSPACE_ROOT_PATH` to the nearest ancestor of the working directory whose `node_modules/@spinajs` is not empty, up to the workspace root, when the variable is unset;
   2. builds `CommonDirs`, the search list below;
   3. sets `BasePath` to the nearest ancestor of the working directory that has a `node_modules` folder, or the working directory itself.
2. **`Load(configuration)`** reads the environment with `getEnvironment(configuration)` (see [Environments](02-environments.md)), then calls `load()` twice:
   1. common files: `**/!(*.*).{cjs,js}` or `**/!(*.*).json`, file names with no dot before the extension;
   2. environment files: `**/*.<env>.{cjs,js}` or `**/*.<env>.json`.
3. **`load(extension, callback)`** resolves relative directories against `BasePath`, globs each directory recursively, removes duplicate paths, runs `callback` on each file in parallel and deep-merges the results in directory order. A module's `default` export is used when present.
4. **Per file.** `JsFileSource` imports the module with `DI.__spinajs_require__()`, calls its `onConfigLoad(cfg)` when it exports one and uses the returned object. `JsonFileSource` reads and parses the file. Both add `__file__: [path]` to every top-level object.
5. The environment result is merged over the common result and returned to the configuration.

A file that fails to import or parse is logged with `InternalLogger.error` and counts as `{}`. The boot goes on.

## Search directories

In merge order; later directories win for scalars:

| # | Directory | When |
| --- | --- | --- |
| 1 | `<cwd>/src/config` | always (package tests) |
| 2 | `<dir>/node_modules/@spinajs/*/lib/<mjs\|cjs>/config` for every ancestor `<dir>` of the working directory that has `node_modules`, nearest first, up to the workspace root | always |
| 3 | `<WORKSPACE_ROOT_PATH>/node_modules/@spinajs/*/lib/<mjs\|cjs>/config` | when `WORKSPACE_ROOT_PATH` is set or detected |
| 4 | `<cwd>/lib/config`, `<cwd>/dist/config`, `<cwd>/build/config`, `<cwd>/config` | always |
| 5 | `<appBaseDir>/<app>/config` | when `app` and `appBaseDir` are set |
| 6 | `<cwd>/apps/<app>/config`, `<cwd>/dist/apps/<app>/config`, `<cwd>/lib/apps/<app>/config`, `<cwd>/build/apps/<app>/config` | when `app` is set |
| 7 | each `cfgCustomPaths` entry; relative ones resolve against `BasePath` | when set |

The workspace root is the nearest ancestor, the working directory included, whose `package.json` declares `workspaces` or that holds a `pnpm-workspace.yaml`. Directories above it belong to another project and are not searched, so a checkout nested in another one (a git worktree inside the main checkout) does not load the outer checkout's packages. Without a workspace root the search goes up to the filesystem root.

`mjs` is used when ESM mode is on (`DI.setESMModuleSupport()`), `cjs` otherwise. A directory that does not exist is skipped.

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

A package config points `system.dirs` at its own build with `packageLibDirs(pkg, sub)`. It returns two paths, `<root>/node_modules/<pkg>/lib/<cjs|mjs>/<sub>` and the same one directory up (for a process started from an app or build folder), where `<root>` is `WORKSPACE_ROOT_PATH`, else the working directory. `cjs` or `mjs` follows how `@spinajs/configuration` was loaded. Node only.

```ts
// src/config/my-package.ts
import { packageLibDirs } from '@spinajs/configuration';

export default {
  system: { dirs: { cli: packageLibDirs('@spinajs/my-package', 'cli') } },
};
```

`merge(to, from)` and `mergeArrays` are exported too: `merge` deep-merges in place and unions arrays; `mergeArrays` is the `_.mergeWith` customizer the configuration merges sources with (arrays concatenated).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| JS file source | `ConfigurationSource`, singleton (`@Injectable(ConfigurationSource)`), `Order` 1 | `JsFileSource` | none | Subclass `BaseFileSource`; or remove it with `DI.unregister(JsFileSource)` before the configuration resolves. |
| JSON file source | `ConfigurationSource`, singleton (`@Injectable(ConfigurationSource)`), `Order` 1 | `JsonFileSource` | none | Same as above. |
| File source base | abstract class `BaseFileSource` | none | `JsFileSource`, `JsonFileSource` | Extend it for another format; override `Order` and `getEnvironment()` as needed. |
| Module loader | `__module_loader__` DI value, read by `DI.__spinajs_require__()` | `import()` in ESM mode, `require()` otherwise | any `{ load(path) }` | Register to load config modules in a bundled build. See [`@spinajs/di`](../di/README.md). |

### BaseFileSource: custom file format

Subclass `BaseFileSource` to load a format the framework does not read: YAML, TOML, `.env` files. You get the full search list and the environment handling; you write only the parser.

| Member | Kind | Use |
| --- | --- | --- |
| `Load(configuration)` | abstract, from `ConfigurationSource` | Call `this.load()` for the common and the environment pattern, merge the two. |
| `load(extension, callback)` | protected | Globs `extension` under every search directory; `callback(file)` returns a promise of the parsed object. |
| `getEnvironment(configuration)` | protected | Returns the normalized environment name. |
| `Order` | getter, `1` | Override to load before or after the other sources. |
| `CommonDirs`, `BasePath` | protected fields | Read or extend the search list in your constructor. |

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

- Files load in two passes: every common file from every directory, then every environment file. An environment file in a package directory still wins over a common file in your project.
- A file whose name has a dot before the extension (`my.settings.js`) is not a common file. It loads only when the environment is named after its second part (`settings`).
- Directories are globbed recursively: `config/nested/db.js` loads like `config/db.js`. The directory structure does not change the config keys; only the exported object does.
- A config module that throws on import, or a JSON file with a syntax error, is logged and skipped. The configuration boots without it, and a schema may then fill defaults for the missing module.
- Without `DI.setESMModuleSupport()`, the sources search `lib/cjs/config` of each `@spinajs` package and load files with `require()`. An ESM app must call it before the configuration resolves.
- `WORKSPACE_ROOT_PATH` is detected once per source construction and written to `process.env`. In a workspace, without it, package configs build paths under the app package that do not exist.
- The ancestor walk (row 2 and the `WORKSPACE_ROOT_PATH` detection) stops at the workspace root, but an explicit `WORKSPACE_ROOT_PATH` is searched wherever it points (row 3). In a nested checkout, leave it unset or point it at the inner checkout, or the outer packages load again.
- A project with neither `workspaces` nor `pnpm-workspace.yaml` walks up to the filesystem root. Inside another project's tree it loads that project's `@spinajs` package configs; add a `pnpm-workspace.yaml` or a `workspaces` entry to stop the walk.
- The sources are singletons: the constructor arguments (`app`, paths, `Env`) are read when a source is first resolved in a container.
- A `.js` config module runs as code at boot. Keep it free of side effects other than building the object; put setup in a [`configure()` hook](01-configuration-service.md#configure-hooks).

## Best practices

- Put shared values in `config/<module>.js` and per-environment values in `config/<module>.<env>.js`; one top-level key per file, named like the file.
- Keep secrets out of files: use a protocol string such as `aws-secrets://...` (see [Config var protocols](05-config-var-protocols.md)) or `process.env`.
- In tests, point `cfgCustomPaths` at a fixtures directory instead of changing the working directory.

## Patterns and antipatterns

```js
// Don't: arrays concatenate across files, so this cannot remove the package's default origin
export default { http: { cors: { origins: ['https://app.example.com'] } } };

// Do: when you need to replace a list, set it in code after boot or in a configure() hook
export default {
  http: {
    configure() {
      this.set('http.cors.origins', ['https://app.example.com']);
    },
  },
};
```

## Examples

### Load configs from a deployment directory in tests

```ts sample
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

async function main() {
  DI.setESMModuleSupport();

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
