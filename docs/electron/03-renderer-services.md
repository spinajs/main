# Renderer service proxies

The renderer entry registers stand-ins for main-process services under the same DI tokens: `Configuration`, `Intl`, `Templates` and `EmailService`. Renderer code and SpinaJS packages that inject these tokens get a proxy that forwards each call over IPC to the real service in main. Logging and the ORM have their own pages: [Renderer logging](04-renderer-logging.md), [Renderer ORM bridge](05-renderer-orm.md).

## How it works

1. A bundler with the `browser` condition loads `lib/mjs/renderer.js` for `import ... from '@spinajs/electron'`.
2. The module's decorators and `DI.register()` calls register the proxies in the renderer's root container.
3. Renderer code resolves a token, eg. `await DI.resolve(Configuration)`, and gets the proxy.
4. A proxy method calls `window.ipc.__spinaJsIpcBridge.call()` or `.callSync()` with the method name, the service's DI name and the arguments.
5. The main process runs the method on its own instance, see [Main process IPC bridge](01-main-process-bridge.md).

The DI key of a class is its name. A proxy class named `Intl` or `Templates` therefore lands on the same key as the class of that name in `@spinajs/intl` or `@spinajs/templates`. That is why renderer packages that inject the real classes still receive the proxies, and why this package redeclares `Intl`, `Templates`, `EmailService` and `IEmail` instead of importing packages that need Node APIs.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Configuration | `Configuration` (from `@spinajs/configuration-common`) and `ElectronRendererConfiguration`; singleton; `@Injectable(Configuration)` | `ElectronRendererConfiguration`: `get()` over `callSync('get', 'Configuration', path, defaultValue)` | | Subclass and `DI.register(MyConfig).as(Configuration)` after importing the renderer entry. |
| Intl | `Intl` (abstract class exported by this package) and `ElectronRendererIntl`; singleton; `@Injectable(Intl)` | `ElectronRendererIntl`: `__()` over `callSync('__', 'Intl', text, ...args)` | | Subclass `ElectronRendererIntl` to add `__n()`, `__l()`, `__h()`; register `.as(Intl)`. |
| Templates | `Templates`; singleton; `@Injectable()` | `Templates`: `render()` and `renderToFile()` over `call(..., 'Templates', [], ...)` | | Subclass and `DI.register(MyTemplates).as(Templates)`. |
| EmailService | `EmailService`; singleton; `@Injectable()` | `EmailService`: `send()` over `callSync('send', 'EmailService', email)` | | Subclass and `DI.register(MyEmail).as(EmailService)`. |
| Your own proxy | Any token; any lifetime | | | Write a class that calls `window.ipc.__spinaJsIpcBridge`, register it. |

### `ElectronRendererConfiguration`

| Member | Behaviour |
| --- | --- |
| `get<T>(path, defaultValue?)` | Synchronous `callSync('get', 'Configuration', path, defaultValue)`. Returns the main value, structured-cloned. |
| `RootConfig`, `set()`, `merge()`, `mergeSource()`, `load()`, `onLoad()` | Throw `Method not implemented.` |

`ElectronRendererConfiguration` extends `Configuration` so that type checks and `@Autoinject() Configuration` in other packages accept it. `resolve()` is the no-op inherited from `AsyncService`, so resolving it never calls the throwing `load()`.

### `Intl` and `ElectronRendererIntl`

| Member | Behaviour |
| --- | --- |
| `Intl.__(text, ...args)` | Abstract. `text` is a string or `IPhraseWithOptions` (`{ phrase, locale }`). |
| `ElectronRendererIntl.__(text, ...args)` | Synchronous `callSync('__', 'Intl', text, ...args)`. |

The main `Intl` in `@spinajs/intl` has `__n()`, `__l()` and `__h()` too; the renderer proxy does **not**.

### `Templates`

| Member | Behaviour |
| --- | --- |
| `render(template, model, language?)` | `call('render', 'Templates', [], template, model, language)`. Resolves with the rendered string. |
| `renderToFile(template, model, filePath, language?)` | `call('renderToFile', 'Templates', [], ...)`. Writes the file in the main process, at a main-process path. |

### `EmailService` and `IEmail`

| Member | Behaviour |
| --- | --- |
| `send(email: IEmail)` | `callSync('send', 'EmailService', email)`. |

`IEmail` fields: `to`, `cc?`, `bcc?`, `from`, `connection`, `attachements?` (`IEmailAttachement[]`: `name`, `path`, `provider?`), `template?`, `templateId?`, `model?`, `text?`, `subject`, `lang?`, `priority?`, `replyTo?`, `tag?`, `emailId?`.

The main `EmailService.send()` is async, and a promise cannot answer a sync IPC call. Replace the proxy with one that uses `call`, as shown below.

### Configuration: custom implementation

Every `get()` blocks the renderer for one IPC round trip. Cache values that never change during a session by subclassing the proxy.

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';
import { ElectronRendererConfiguration } from '@spinajs/electron';

export class CachedRendererConfiguration extends ElectronRendererConfiguration {
  protected cache = new Map<string, unknown>();

  public get<T>(path: string[] | string, defaultValue?: T): T {
    const key = Array.isArray(path) ? path.join('.') : path;
    if (!this.cache.has(key)) {
      this.cache.set(key, super.get<T>(path, defaultValue));
    }
    return this.cache.get(key) as T;
  }
}

DI.register(CachedRendererConfiguration).as(Configuration);

const config = await DI.resolve(Configuration);
const theme = config.get<string>('app.theme', 'light');
```

Register it before the first `DI.resolve(Configuration)` in the renderer; a resolved singleton stays in the cache.

### Intl: custom implementation

Add plural forms by forwarding `__n()` to the main `Intl`.

```ts
import { DI } from '@spinajs/di';
import { ElectronRendererIntl, IPhraseWithOptions, Intl as SpinaIntl } from '@spinajs/electron';

export class PluralRendererIntl extends ElectronRendererIntl {
  public __n(text: string | IPhraseWithOptions, count: number): string {
    return window.ipc.__spinaJsIpcBridge.callSync<string>('__n', 'Intl', text, count);
  }
}

DI.register(PluralRendererIntl).as(SpinaIntl);

const intl = (await DI.resolve(SpinaIntl)) as PluralRendererIntl;
document.title = intl.__n('%s unread message', 3);
```

### EmailService: custom implementation

Send email over the async channel, so the renderer awaits the real result and gets rejections.

```ts
import { DI } from '@spinajs/di';
import { EmailService, IEmail } from '@spinajs/electron';

export class AsyncEmailService extends EmailService {
  public send(email: IEmail): Promise<void> {
    return window.ipc.__spinaJsIpcBridge.call<void>('send', 'EmailService', [], email);
  }
}

DI.register(AsyncEmailService).as(EmailService);

const email = await DI.resolve(EmailService);
await email.send({
  to: ['billing@example.com'],
  from: 'app@example.com',
  connection: 'default',
  subject: 'Invoice FV/2026/10/17',
  template: 'invoice.pug',
  model: { number: 'FV/2026/10/17' },
});
```

### Templates: custom implementation

The shipped proxy drops the main `IRenderOptions` argument. Subclass it to pass `redact`, so a failed render of a model with a secret never reports the secret. `onProgress` is a function and cannot cross IPC.

```ts
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/electron';

export class RedactingTemplates extends Templates {
  public async renderSecret(template: string, model: unknown, secrets: string[], language?: string): Promise<string> {
    return window.ipc.__spinaJsIpcBridge.call<string>('render', 'Templates', [], template, model, language, { redact: secrets });
  }
}

DI.register(RedactingTemplates).as(Templates);

const templates = (await DI.resolve(Templates)) as RedactingTemplates;
const resetToken = 'f3c9a1d07e';
const html = await templates.renderSecret('password-reset.pug', { resetToken }, [resetToken]);
```

### Your own proxy

For a main service with no shipped proxy, write one. Pick `call` for async methods and `callSync` only for fast synchronous ones that main has already resolved.

```ts
import { DI, Singleton } from '@spinajs/di';
import '@spinajs/electron';

interface IRecentFile {
  path: string;
  openedAt: string;
}

@Singleton()
export class RecentFiles {
  public list(): Promise<IRecentFile[]> {
    return window.ipc.__spinaJsIpcBridge.call<IRecentFile[]>('list', 'RecentFiles', []);
  }

  public add(path: string): Promise<void> {
    return window.ipc.__spinaJsIpcBridge.call<void>('add', 'RecentFiles', [], path);
  }
}

const recent = await DI.resolve(RecentFiles);
await recent.add('C:/Invoices/2026-10.xlsx');
```

## Important behaviour

- **Sync proxies block.** `Configuration.get()`, `Intl.__()` and `EmailService.send()` use `sendSync`; the renderer freezes until main answers.
- **Sync proxies run unattended in main.** A main `get()` or `__()` that runs an authz check is denied there, see [Main process IPC bridge](01-main-process-bridge.md#important-behaviour).
- **Main must resolve the targets first.** `callSync` finds only already-resolved main services: resolve `Configuration`, `Intl` and `EmailService` in main before opening the window.
- **Resolve `Configuration` in the renderer.** `@Config()` properties read `DI.get(Configuration)` when no container is injected; it returns `null` until something calls `DI.resolve(Configuration)`.
- **Values are copies.** Results are structured-cloned: class instances arrive as plain objects, and changing them does not change main.
- **`renderToFile()` writes in main.** `filePath` is a main-process path.
- **The `Intl` export shadows the global.** `import { Intl } from '@spinajs/electron'` hides the built-in `Intl` (`Intl.NumberFormat`) in that module.

## Best practices

- Name a custom proxy after the main service, or register it under the main DI name, so call sites match in both processes.
- Put `DI.register(...).as(...)` overrides in the module that boots the renderer, before the first resolve.
- Use `call` in your own proxies; keep `callSync` for values the UI needs during synchronous rendering.

## Patterns and antipatterns

```ts
// Don't: shadows the built-in Intl in this module.
import { Intl } from '@spinajs/electron';
const price = new Intl.NumberFormat('pl-PL').format(199.9); // TypeError

// Do
import { Intl as SpinaIntl } from '@spinajs/electron';
const intl = await DI.resolve(SpinaIntl);
const price = new Intl.NumberFormat('pl-PL').format(199.9);
```

```ts
// Don't: the proxy implements only get(); set() throws.
config.set('app.theme', 'dark');

// Do: a main-process service that owns the setting.
await window.ipc.__spinaJsIpcBridge.call('setTheme', 'SettingsService', [], 'dark');
```

## Related

- [Main process IPC bridge](01-main-process-bridge.md): how the calls run in main.
- [Renderer logging](04-renderer-logging.md): the `Log` proxy.
- [Renderer ORM bridge](05-renderer-orm.md): the `Orm` proxy.
- [`@spinajs/configuration`](../configuration/README.md), [`@spinajs/intl`](../intl/README.md), [`@spinajs/templates`](../templates/README.md), [`@spinajs/email`](../email/README.md): the services the proxies call.
