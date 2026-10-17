# Browser pool

`BrowserPool` keeps one Chromium per renderer and reuses it across renders. Launching Chromium is the slowest step of a render; the pool pays it once, relaunches after a crash, and closes the browser on `dispose()`. Replace it to render in a remote browser (a browserless service, a shared Chrome container).

## How it works

1. `PuppeteerRenderer.browserPool` builds `new BrowserPool(this.Log, () => this.buildLaunchOptions())` on first access. The launch options are read at launch time, so the injected config is ready.
2. `renderContentToFile()` calls `browserPool.acquire()` for each render.
3. `acquire()` returns the pooled browser when `browser.connected` is `true`.
4. Otherwise it drops the stale browser and calls `puppeteer.launch(options)`. Concurrent callers wait on the same launch promise.
5. A failed launch rejects every waiting caller and clears the promise; the next `acquire()` tries again.
6. Each render opens its own page on the shared browser and closes only that page.
7. `PuppeteerRenderer.dispose()` calls `browserPool.dispose()`: it closes all pages, then the browser. If that fails it sends `SIGKILL` to the browser process.

Launch options are `{ ...Options.args, executablePath: Options.executablePath }`; `executablePath` is added only when set. See [Configuration](01-rendering-to-files.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `BrowserPool` | Not in DI; one per renderer instance, built by the protected `browserPool` getter | `BrowserPool` (local `puppeteer.launch()`) | none shipped | Subclass `BrowserPool`, override the renderer's `browserPool` getter and `dispose()` |

`BrowserPool` public API:

| Member | Effect |
| --- | --- |
| `constructor(log: Log, launchOptions: () => LaunchOptions)` | `launchOptions` is called at each launch |
| `browser` | The pooled `Browser`, or `null` when none is live |
| `acquire(): Promise<Browser>` | Returns a connected browser, launching or relaunching it |
| `dispose(): Promise<void>` | Closes pages and browser; a no-op when none is live |

### Render in a remote Chrome

Override `acquire()`, `dispose()` and `browser` when the browser is not a local child process. The base class keeps its state in private fields, so a subclass keeps its own.

The renderer's `dispose()` only disposes the pool it built itself. When you override the `browserPool` getter, override `dispose()` too.

```ts sample
import puppeteer, { Browser } from 'puppeteer';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log } from '@spinajs/log';
import { TemplateRenderer } from '@spinajs/templates';
import { BrowserPool } from '@spinajs/templates-puppeteer';
import { PdfRenderer } from '@spinajs/templates-pdf';

export class RemoteBrowserPool extends BrowserPool {
  private remote: Browser | null = null;
  private connecting: Promise<Browser> | null = null;

  constructor(log: Log, private readonly endpoint: () => string) {
    super(log, () => ({}));
  }

  public get browser(): Browser | null {
    return this.remote;
  }

  public async acquire(): Promise<Browser> {
    if (this.remote?.connected) {
      return this.remote;
    }

    this.connecting ??= puppeteer
      .connect({ browserWSEndpoint: this.endpoint() })
      .then((b) => (this.remote = b))
      .finally(() => (this.connecting = null));

    return this.connecting;
  }

  public async dispose(): Promise<void> {
    // disconnect only: the remote Chrome is shared and outlives this process
    await this.remote?.disconnect();
    this.remote = null;
  }
}

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class RemotePdfRenderer extends PdfRenderer {
  @Config('templates.pdf.remoteEndpoint', { defaultValue: 'ws://chrome.internal:3000' })
  protected RemoteEndpoint: string;

  private remotePool?: RemoteBrowserPool;

  protected get browserPool(): BrowserPool {
    return (this.remotePool ??= new RemoteBrowserPool(this.Log, () => this.RemoteEndpoint));
  }

  public async dispose(): Promise<void> {
    await this.remotePool?.dispose();
    await super.dispose();
  }
}

// before Templates or PdfRenderer is first resolved
DI.unregister(PdfRenderer);
DI.register(RemotePdfRenderer).as(PdfRenderer);
```

Each render still opens a page and closes it; only the browser is shared. The asset server keeps running on the renderer's host at `127.0.0.1`, so a remote Chrome cannot reach it. Use absolute `http(s)` asset URLs the remote browser can load, or replace the [local asset server](05-local-asset-server.md) with one bound to a reachable address.

## Important behaviour

- One renderer instance owns one browser. `PdfRenderer` and `ImageRenderer` each launch their own Chromium.
- Every renderer instance built by `DI.resolve(Renderer, [options])` has its own pool, and so its own Chromium; see [one renderer per set of options](03-custom-renderers.md#one-renderer-per-set-of-options).
- Launch options are read once per launch. Changing `args` after the first render takes effect only after a crash or `dispose()`.
- A crashed browser is detected on the next `acquire()` through `browser.connected`. A render that is running when Chromium dies fails; the next one relaunches.
- `dispose()` closes the browser even when other renders still use it. Dispose at shutdown, not between renders.
- `debug.close: false` keeps pages open, but `dispose()` still closes the browser and its pages.

## Best practices

- Call `DI.dispose()` at shutdown, or `renderer.dispose()` in one-shot scripts. A live Chromium keeps the Node process running.
- Pass `--no-sandbox` and `--disable-dev-shm-usage` in `args.args` in containers without a user namespace or with a small `/dev/shm`.
- Set `executablePath` to a system Chrome when Puppeteer cannot download its own Chromium.

## Patterns and antipatterns

```ts
// Don't: disposing after every render relaunches Chromium each time
await renderer.renderHtmlToFile(html, out);
await renderer.dispose();

// Do: render many times, dispose once at shutdown
await renderer.renderHtmlToFile(html, out);
// ...
process.on('SIGTERM', () => void DI.dispose());
```

## Examples

### Launch a system Chrome inside a container

```ts
// config/templates.ts in your app
export default {
  templates: {
    pdf: {
      executablePath: '/usr/bin/google-chrome-stable',
      args: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    },
  },
};
```

## Related

- [Rendering to files](01-rendering-to-files.md): where the pool is used in the flow.
- [Custom Puppeteer renderers](03-custom-renderers.md): registering the renderer that owns your pool.
- [Local asset server](05-local-asset-server.md): the other per-render collaborator.
