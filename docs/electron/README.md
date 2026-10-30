# `@spinajs/electron`

Runs SpinaJS services in the Electron main process and calls them from the renderer over IPC. The main process keeps the real services (configuration, logging, ORM, intl, templates, email); the renderer gets thin proxies with the same DI tokens.

It does **not** create windows, register a preload script for you, or limit which services a renderer may call. Every method of every service in the main DI container is reachable from a renderer that has the bridge.

## Install

```sh
npm install @spinajs/electron
```

`electron` is only a dev dependency of this package: your app provides it.

## Entry points

The package has three pieces, each for one Electron process.

| Piece | Process | How you load it | What it does on load |
| --- | --- | --- | --- |
| `@spinajs/electron` (condition `node`) | main | `import '@spinajs/electron'` | Registers the three IPC handlers (`exposeIpcBridge()`) and the `ElectronPathVariables` config variable. |
| `lib/preload.js` | preload | `webPreferences.preload` path | Exposes `window.ipc.__spinaJsIpcBridge` through `contextBridge`. |
| `@spinajs/electron` (condition `browser`) | renderer | `import ... from '@spinajs/electron'` in a bundled renderer | Registers renderer proxies for `Configuration`, `Intl`, `Log`, `Orm`, `Templates`, `EmailService` and the ORM driver tokens. |

`package.json` exports only `.`, so no subpath like `@spinajs/electron/lib/preload.js` can be imported. See [Preload script](02-preload-script.md) for how to ship the preload.

## Features

| Feature | What it does |
| --- | --- |
| [Main process IPC bridge](01-main-process-bridge.md) | Three IPC channels that resolve a service or ORM connection by name and call a method on it, as `SYSTEM` under authz. |
| [Preload script](02-preload-script.md) | The `window.ipc.__spinaJsIpcBridge` contract between renderer and main, and how to replace it with a restricted one. |
| [Renderer service proxies](03-renderer-services.md) | `ElectronRendererConfiguration`, `ElectronRendererIntl`, `Templates` and `EmailService`, and how to write your own proxy. |
| [Renderer logging](04-renderer-logging.md) | The renderer `Log` factory and `ElectronRendererLogger`, which forward log calls to main-process loggers. |
| [Renderer ORM bridge](05-renderer-orm.md) | `ElectronRendererOrm` and `RendererOrmDriverBridge`, which forward raw statements and `tableInfo()` to main connections. |
| [Electron path variables](06-electron-path-variables.md) | The `${electron-path:<name>}` config variable backed by `app.getPath()`. |

## Quick start

Main process: import the logger first, then the bridge, then boot your services.

```ts sample
import '@spinajs/log';
import '@spinajs/electron';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { app, BrowserWindow } from 'electron';
import { join } from 'path';

app.whenReady().then(async () => {
  await DI.resolve(Configuration);

  const win = new BrowserWindow({
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload.js'),
      contextIsolation: true,
    },
  });

  await win.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
});
```

Renderer (bundled with the `browser` export condition): resolve the proxies once, then use them as the normal services.

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';
import { Log } from '@spinajs/log-common';
import '@spinajs/electron';

const config = await DI.resolve(Configuration);
const log = DI.resolve(Log, ['renderer']);

log.info(`Window opened, theme ${config.get<string>('app.theme', 'light')}`);
```

## TypeScript setup for renderer code

The renderer classes and the `window.ipc` global type sit behind the `browser` export condition. TypeScript picks that condition only when you ask for it:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "customConditions": ["browser"]
  }
}
```

Without it, `import { ElectronRendererLogger } from '@spinajs/electron'` resolves to the main-process entry and fails. For the same reason, the renderer examples in these pages are partial ` ```ts ` blocks, not type-checked samples.

## Related packages

- [`@spinajs/di`](../di/README.md): every proxy is a DI registration; the bridge resolves services by their DI name.
- [`@spinajs/authz`](../authz/01-check-flow.md#concepts): IPC calls run as `SYSTEM` through `authz().runAs()`.
- [`@spinajs/orm`](../orm/README.md): the main-process `Orm` owns the connections the renderer bridge talks to.
- [`@spinajs/log`](../log/README.md): main-process loggers receive the renderer's log lines.
- [`@spinajs/configuration`](../configuration/README.md): the main `Configuration` answers renderer `get()` calls and formats `${electron-path:...}`.
