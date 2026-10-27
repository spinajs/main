# Preload script

The preload script exposes `window.ipc.__spinaJsIpcBridge` to the renderer. Every renderer proxy in this package calls that object, so the window needs a preload that provides it. Use the shipped one as a reference, or write your own to restrict what the renderer may call.

## How it works

1. Electron runs the script set in `webPreferences.preload` before the page loads.
2. The script builds an object with three functions and calls `contextBridge.exposeInMainWorld('ipc', _ipc)`.
3. The page sees it as `window.ipc.__spinaJsIpcBridge`, typed by `IpcRenderer` and `IIpcRendererBridge` from the renderer entry.
4. Each function forwards to one main-process channel, see [Main process IPC bridge](01-main-process-bridge.md#how-it-works):

| Function | Electron call | Result |
| --- | --- | --- |
| `call(method, service, resolveArgs, ...args)` | `ipcRenderer.invoke('__spinajsIpcBridge:call', ...)` | `Promise` of the method result. |
| `callSync(method, service, ...args)` | `ipcRenderer.sendSync('__spinajsIpcBridge:callSync', ...)` | The method result. Throws when main answers with an `Error`. |
| `callOnOrmConnection(connection, method, ...args)` | `ipcRenderer.invoke('__spinajsIpcBridge:callOnOrmConnection', ...)` | `Promise` of the driver method result. |

### The `window.ipc` contract

The renderer entry declares the global:

```ts
export interface IIpcRendererBridge {
  call<T>(method: string, service: string, resovleArgs: any[], ...args: any[]): Promise<T>;
  callSync<T>(method: string, service: string, ...args: any[]): T;
  callOnOrmConnection(connection: string, method: string, ...args: any[]): Promise<any>;
}

export interface IpcRenderer {
  __spinaJsIpcBridge: IIpcRendererBridge;
}

declare global {
  interface Window {
    ipc: IpcRenderer;
  }
}
```

Any preload that exposes an object of this shape under `ipc` works with the renderer proxies.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Preload bridge | Not in DI; `window.ipc` set once per page through `contextBridge` | `lib/preload.js` | Your own preload | Point `webPreferences.preload` at your script. Keep the `IIpcRendererBridge` shape. |

### Preload bridge: custom implementation

Write your own preload when you need to:

- restrict which services, methods and connections a page may reach (the shipped one forwards everything);
- ship the preload as CommonJS or bundle it with the rest of your preload code;
- add logging or timing around IPC calls.

The shipped file is not reachable through the package `exports` map, and it is an ES module with a `.js` extension. Electron loads an ES module preload only from a `.mjs` file in a non-sandboxed window (Electron 28 and later). Writing your own preload avoids both limits.

A page with this preload can call only the listed services, methods and connections. Calls outside the list throw in the renderer and never reach the main process.

```ts sample
import { contextBridge, ipcRenderer } from 'electron';

const allowedServices: Record<string, readonly string[]> = {
  Configuration: ['get'],
  Intl: ['__'],
  Log: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security', 'success'],
  Templates: ['render'],
  InvoiceService: ['list', 'cancel'],
};

const allowedOrmCalls: Record<string, readonly string[]> = {
  default: ['tableInfo'],
};

function assertAllowed(table: Record<string, readonly string[]>, target: string, method: string) {
  if (!table[target]?.includes(method)) {
    throw new Error(`IPC call ${target}.${method}() is not allowed from this window`);
  }
}

contextBridge.exposeInMainWorld('ipc', {
  __spinaJsIpcBridge: {
    call: (method: string, service: string, ...args: unknown[]) => {
      assertAllowed(allowedServices, service, method);
      return ipcRenderer.invoke('__spinajsIpcBridge:call', method, service, ...args);
    },

    callSync: (method: string, service: string, ...args: unknown[]) => {
      assertAllowed(allowedServices, service, method);
      const result = ipcRenderer.sendSync('__spinajsIpcBridge:callSync', method, service, ...args);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },

    callOnOrmConnection: (connection: string, method: string, ...args: unknown[]) => {
      assertAllowed(allowedOrmCalls, connection, method);
      return ipcRenderer.invoke('__spinajsIpcBridge:callOnOrmConnection', connection, method, ...args);
    },
  },
});
```

Load it from the main process:

```ts sample
import '@spinajs/log';
import '@spinajs/electron';
import { app, BrowserWindow } from 'electron';
import { join } from 'path';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  return win.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
});
```

A sandboxed preload can import only `electron` and a few Node built-ins, so bundle it (esbuild, webpack, Vite) into one CommonJS file.

## Important behaviour

- **`contextIsolation` must be on.** `contextBridge.exposeInMainWorld()` throws when it is off, and `window.ipc` is then never set.
- **The renderer never gets `ipcRenderer`.** Only the three functions cross the context bridge. A filter in the preload cannot be bypassed from page scripts.
- **Sync errors are thrown, async errors reject.** `callSync` throws an `Error` it receives. `call` and `callOnOrmConnection` return the rejected `invoke()` promise, see [error shapes](01-main-process-bridge.md#important-behaviour).
- **Errors lose their class.** Errors crossing IPC arrive as plain `Error` objects; custom subclasses and extra fields do not survive.

## Best practices

- Ship an allowlist preload for any window that shows remote or user-supplied content.
- Keep the function names and argument order of `IIpcRendererBridge`; the renderer proxies depend on them.
- Allow `Log` methods in every window, or renderer logging calls fail.

## Patterns and antipatterns

```ts
// Don't: hands the page full IPC access to every channel in the app.
contextBridge.exposeInMainWorld('ipcRenderer', ipcRenderer);

// Do: expose only the bridge functions, filtered.
contextBridge.exposeInMainWorld('ipc', { __spinaJsIpcBridge: { call, callSync, callOnOrmConnection } });
```

## Related

- [Main process IPC bridge](01-main-process-bridge.md): what each channel does in main.
- [Renderer service proxies](03-renderer-services.md): the callers of `window.ipc.__spinaJsIpcBridge`.
