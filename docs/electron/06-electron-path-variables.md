# Electron path variables

`ElectronPathVariables` adds the `${electron-path:<name>}` variable to SpinaJS layouts. It resolves to an Electron app path such as the user data folder, so log files and other configured paths land in the right per-user location on every OS.

## How it works

1. Importing the main entry evaluates `@Injectable(ConfigVariable)` on `ElectronPathVariables`, which registers it in the `ConfigVariable` list.
2. The first call to `format()` from `@spinajs/configuration-common` resolves `Array.ofType(ConfigVariable)` and caches every variable by `Name`.
3. `format()` replaces `${electron-path:<option>}` with `ElectronPathVariables.Value('<option>')`:
   - `cwd`: `dirname(app.getPath('exe'))`, the folder of the app executable;
   - any other option: `app.getPath(option)`.

Layouts that go through `format()` include the log `layout` and the `FileTarget` `path` and `archivePath` options of [`@spinajs/log`](../log/README.md).

## Configuration

| Variable | Value |
| --- | --- |
| `${electron-path:cwd}` | Folder that holds the app executable. |
| `${electron-path:home}` | User home directory. |
| `${electron-path:appData}` | Per-user application data directory. |
| `${electron-path:userData}` | This app's data directory, `appData` plus the app name. |
| `${electron-path:sessionData}` | Directory for session data (cookies, caches). |
| `${electron-path:temp}` | Temporary directory. |
| `${electron-path:exe}` | Path of the executable file itself. |
| `${electron-path:logs}` | This app's log directory. |
| `${electron-path:desktop}`, `documents`, `downloads`, `music`, `pictures`, `videos` | The user's folders. |
| `${electron-path:crashDumps}` | Crash dump directory. |

Any name `app.getPath()` accepts works. An unknown name throws from `app.getPath()`.

`FileTarget` paths are relative to the target's fs provider base path, and `@spinajs/log` roots its default provider `fs-log-default` at `process.cwd()`. The local provider rejects paths that escape its base path, so an absolute `${electron-path:logs}/app.log` fails there. Give the target an fs provider rooted at the Electron folder instead, and keep the target path relative:

```ts
import { app } from 'electron';

export default {
  fs: {
    providers: [{ name: 'fs-electron-logs', service: 'fsNative', basePath: app.getPath('logs') }],
  },
  logger: {
    targets: [
      {
        name: 'File',
        type: 'FileTarget',
        options: { fs: 'fs-electron-logs', path: 'app_${date:dd_MM_yyyy}.log' },
      },
    ],
  },
};
```

Use `${electron-path:...}` where the formatted string is not sandboxed, eg. in a log `layout`, or in a `FileTarget` path whose provider base path contains the Electron folder.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Config variable | `ConfigVariable` (list, `Array.ofType`) and `ElectronPathVariables`; singleton; `@Injectable(ConfigVariable)` | `ElectronPathVariables`, `Name` = `electron-path` | `@spinajs/configuration-common` ships `datetime`, `date`, `time`, `env`, `path` and others | Add a new `ConfigVariable` with its own `Name`; or subclass `ElectronPathVariables` and register it `.as(ConfigVariable)`. |

### Config variable: custom implementation

Add an `electron-app` variable for app metadata, eg. to put the version in every log line. `ConfigVariable` has two members: `Name` (the text before `:`) and `Value(option)` (the text after it).

```ts sample
import '@spinajs/electron';
import { Injectable } from '@spinajs/di';
import { ConfigVariable } from '@spinajs/configuration-common';
import { app } from 'electron';

@Injectable(ConfigVariable)
export class ElectronAppVariables extends ConfigVariable {
  public get Name(): string {
    return 'electron-app';
  }

  public Value(option?: string): string {
    switch (option) {
      case 'version':
        return app.getVersion();
      case 'locale':
        return app.getLocale();
      default:
        return app.getName();
    }
  }
}

export const logLayout = '${datetime} ${level} [${electron-app:name} ${electron-app:version}] ${message} (${logger})';
```

Use it in config as `${electron-app:version}`. Two variables with the same `Name` overwrite each other in the cache; the one registered last wins.

### Extending `ElectronPathVariables`

Subclass it to add options while keeping the shipped ones, eg. a `portable` option that stores data next to the executable:

```ts
import { Injectable } from '@spinajs/di';
import { ConfigVariable } from '@spinajs/configuration-common';
import { ElectronPathVariables } from '@spinajs/electron';
import { app } from 'electron';
import { dirname, join } from 'path';

@Injectable(ConfigVariable)
export class PortablePathVariables extends ElectronPathVariables {
  public Value(option?: string): string {
    if (option === 'portable') {
      return join(dirname(app.getPath('exe')), 'data');
    }
    return super.Value(option);
  }
}
```

Both classes then sit in the `ConfigVariable` list with `Name` `electron-path`; the cache keeps the one registered last. Register the subclass in a module imported after `@spinajs/electron`.

## Important behaviour

- **Registered at import.** The variable exists only after `@spinajs/electron` is imported in main. Import it before anything formats a layout: `format()` fills its variable cache once, on first use.
- **Main process only.** `ElectronPathVariables` calls `app.getPath()`; the renderer entry does not register it.
- **No option throws.** `${electron-path}` without an option calls `app.getPath(undefined)`, which throws.
- **`cwd` is not the process cwd.** It is the executable's folder, not `process.cwd()`.
- **Some paths need a ready app.** Electron documents that a few `app.getPath()` names are valid only after `app` is ready.

## Best practices

- Root log fs providers at `app.getPath('logs')` or `app.getPath('userData')`; the install folder (`cwd`) is often read-only.
- Use `${electron-path:...}` in config shared by main and tools only when those tools also run inside Electron.

## Related

- [`@spinajs/configuration`](../configuration/README.md): `ConfigVariable` and `format()`.
- [`@spinajs/log`](../log/README.md): `FileTarget` paths and layouts that use the variable.
