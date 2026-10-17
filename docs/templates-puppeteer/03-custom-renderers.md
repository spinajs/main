# Custom Puppeteer renderers

`PuppeteerRenderer` is an abstract `TemplateRenderer`. Subclass it to produce a new output from a Chromium page (an HTML snapshot, a WebP thumbnail, a tagged PDF), or subclass a shipped renderer to change how it loads pages. The base class owns the asset server, the browser pool, timeouts, logging and progress; your class writes the file.

## How it works

1. You declare a subclass with `@Injectable(TemplateRenderer)`. The decorator registers it under `TemplateRenderer` and under its own class.
2. `Templates` injects every `TemplateRenderer` with `@Autoinject(TemplateRenderer)`.
3. `Templates.renderToFile(template, ...)` picks the first renderer whose `Extension` equals `extname(template)`. `Templates.compileToFile(template, type, ...)` picks the first whose `Type` equals `type`. No match throws `InvalidOperation`.
4. You can also resolve the renderer directly: `DI.resolve(MyRenderer, [creationOptions])`.
5. Rendering runs the shared flow of [Rendering to files](01-rendering-to-files.md). At the end it calls your `performRender(page, filePath)`.

## What to implement

| Member | Kind | Required | Meaning |
| --- | --- | --- | --- |
| `Type` | getter | yes | Renderer name for `Templates.compileToFile()`, eg. `'pdf'` |
| `Extension` | getter | yes | File extension, with the dot, for `Templates.renderToFile()`; also stripped to find the `.pug` source. It is the renderer's `ServiceName` too |
| `Options` | property | yes | `IPuppeteerRendererOptions`; decorate it with `@Config('<your key>')` |
| `performRender(page, filePath)` | method | yes | Writes the output from the loaded page |
| `instanceOptions` | getter | no | Value compared by `__checkInstance__()`; default `undefined` |

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Injectable(TemplateRenderer)` | class | the token | Adds the renderer to the list `Templates` searches |
| `@PerInstanceCheck()` | class | none | Reuses a cached renderer when `__checkInstance__(options)` returns `true` |
| `@Config(path)` | `Options` property | config path | Reads `IPuppeteerRendererOptions` from that path on every access |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Puppeteer renderer | `TemplateRenderer` list, plus its own class; `@PerInstanceCheck()` in the shipped renderers | none here | `PdfRenderer` (`.pdf`, `templates.pdf`), `ImageRenderer` (`.png` or `.<type>`, `templates.image`) | Subclass `PuppeteerRenderer`; register with `@Injectable(TemplateRenderer)` |
| Shipped renderer for an extension | `TemplateRenderer` list; the first match wins | `PdfRenderer` for `.pdf` | Your subclass | `DI.unregister(PdfRenderer)`, then register your subclass, before `Templates` is first resolved |
| Page setup hooks | protected methods of `PuppeteerRenderer` | see the table below | your overrides | Override in a subclass and call `super` where it makes sense |
| Per-options instances | `IInstanceCheck.__checkInstance__()` | `JSON.stringify(instanceOptions) === JSON.stringify(creationOptions)` | your override | Override `instanceOptions` or `__checkInstance__()` |

### Protected hooks

| Hook | Default behaviour | Override to |
| --- | --- | --- |
| `performRender(page, filePath)` | abstract | Write your output |
| `renderContentToFile(filePath, opts, prepare)` | The whole flow; `prepare(page, port, markLoading)` fills the page | Wrap `prepare` to set up the page before content loads (request interception, cookies, emulation) |
| `configurePageTimeouts(page)` | `setDefaultNavigationTimeout()` and `setDefaultTimeout()` from config | Set other per-page defaults |
| `armRenderWatchdog(page)` | Closes the page after `renderTimeout`; returns a canceller | Change what happens on timeout, eg. a metric |
| `addPageEventListeners(page)` | Logs console, page errors, responses, failed requests; returns a cleanup function | Add listeners; return a cleanup that also runs the base cleanup |
| `injectBaseHref(html, baseUrl)` | Adds `<base href>` for raw HTML | Rewrite asset URLs differently |
| `warnIfSlow(filePath, duration)` | Warns above `renderDurationWarning` | Report slow renders elsewhere |
| `closePage(page)` | `page.close()`, errors downgraded to warnings | Keep pages for a page pool |
| `assetServer` getter | One `LocalAssetServer` per renderer | Supply your own server; see [Local asset server](05-local-asset-server.md) |
| `browserPool` getter | One `BrowserPool` per renderer | Supply your own pool; see [Browser pool](04-browser-pool.md) |
| `renderTimeoutMs` getter | `renderTimeout` or `30000` | Compute the timeout per renderer |

Public methods you can also override: `renderToFile()`, `renderHtmlToFile()`, `render()` (throws `NotSupported`) and `dispose()` (closes the browser pool, then `super.dispose()`).

### Add a renderer for a new output

Write a subclass when you need a file format Chromium can produce that no shipped renderer covers. Register it at import time; `Templates` finds it by extension.

The example saves the page's HTML after its scripts have run, eg. to archive a dashboard with its charts already drawn.

```ts sample
import { Page } from 'puppeteer';
import { writeFile } from 'fs/promises';
import { DI, Injectable } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Templates, TemplateRenderer } from '@spinajs/templates';
import { PuppeteerRenderer, IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';

@Injectable(TemplateRenderer)
export class HtmlSnapshotRenderer extends PuppeteerRenderer {
  @Config('templates.snapshot')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'snapshot';
  }

  public get Extension() {
    return '.snapshot';
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    // wait until the page's own scripts flag that charts are drawn
    await page.waitForFunction('window.chartsReady === true');
    await writeFile(filePath, await page.content(), 'utf-8');
  }
}

// config/templates.ts: templates.snapshot = { args: { headless: true }, renderTimeout: 60000 }

async function archiveDashboard(month: string): Promise<void> {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  // `.snapshot` selects HtmlSnapshotRenderer; it compiles templates/dashboard.pug
  await templates.renderToFile('templates/dashboard.snapshot', { month }, `archive/dashboard-${month}.html`);
}

void archiveDashboard('2026-09').finally(() => DI.dispose());
```

### One renderer per set of options

The shipped renderers take their Puppeteer options (`PDFOptions`, `ScreenshotOptions`) as a constructor argument and are `@PerInstanceCheck()`. Follow the same shape when your output has per-call options: return them from `instanceOptions`, give the constructor argument a default, and compare against the first element of the options array in `__checkInstance__()`.

```ts sample
import { Page, ScreenshotOptions } from 'puppeteer';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { TemplateRenderer } from '@spinajs/templates';
import { PuppeteerRenderer, IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class ThumbnailRenderer extends PuppeteerRenderer {
  @Config('templates.thumbnail')
  protected Options: IPuppeteerRendererOptions;

  // Templates builds its list instance without options, so the default matters
  constructor(protected size: { width: number; height: number } = { width: 320, height: 240 }) {
    super();
  }

  public get Type() {
    return 'thumbnail';
  }

  public get Extension() {
    return '.webp';
  }

  protected get instanceOptions() {
    return this.size;
  }

  public __checkInstance__(creationOptions: unknown[]): boolean {
    // the container passes the whole options array; compare its first element
    return JSON.stringify(this.size) === JSON.stringify(creationOptions?.[0]);
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.setViewport({ ...this.size, deviceScaleFactor: 1 });
    const options: ScreenshotOptions = { path: filePath as `${string}.webp`, type: 'webp', quality: 80 };
    await page.screenshot(options);
  }
}

async function renderProductThumbnails(): Promise<void> {
  await DI.resolve(Configuration);

  const small = await DI.resolve(ThumbnailRenderer, [{ width: 320, height: 240 }]);
  const sameSmall = await DI.resolve(ThumbnailRenderer, [{ width: 320, height: 240 }]);
  console.log(small === sameSmall); // true: one renderer, one browser

  try {
    await small.renderToFile('templates/product-card.webp', { sku: 'CH-2041' }, 'out/CH-2041.webp');
  } finally {
    await small.dispose();
  }
}

void renderProductThumbnails();
```

### Extend a shipped renderer: block remote requests

Wrap `prepare` in `renderContentToFile()` to change the page before any content loads. Here a PDF renderer refuses every request that does not go to the local asset server, so a template cannot leak data to a tracking pixel or stall on a slow CDN.

`PdfRenderer` already sits in the `TemplateRenderer` list and `Templates` takes the first `.pdf` match. Remove it, then register the subclass, before anything resolves `Templates` or `PdfRenderer`.

```ts sample
import { Page } from 'puppeteer';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { RenderProgressCallback, Templates, TemplateRenderer } from '@spinajs/templates';
import { PdfRenderer } from '@spinajs/templates-pdf';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class OfflinePdfRenderer extends PdfRenderer {
  protected async renderContentToFile(
    filePath: string,
    opts: { assetBasePath?: string; onProgress?: RenderProgressCallback },
    prepare: (page: Page, httpPort: number, markLoading: () => void) => Promise<void>,
  ): Promise<void> {
    return super.renderContentToFile(filePath, opts, async (page, httpPort, markLoading) => {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = new URL(request.url());
        const local = (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === String(httpPort);

        if (local || url.protocol === 'data:') {
          void request.continue();
        } else {
          this.Log.warn({ url: request.url() }, 'Blocked remote request ${url}');
          void request.abort();
        }
      });

      await prepare(page, httpPort, markLoading);
    });
  }
}

// swap the shipped renderer: Templates and DI.resolve(PdfRenderer) now get the offline one
DI.unregister(PdfRenderer);
DI.register(OfflinePdfRenderer).as(PdfRenderer);

async function renderPayslip(employeeId: string): Promise<void> {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  await templates.renderToFile('templates/payslip.pdf', { employeeId }, `out/payslip-${employeeId}.pdf`);
}

void renderPayslip('E-1093').finally(() => DI.dispose());
```

Blocked requests count as `resourcesFailed` in [render progress](02-render-progress.md) and are logged as failed requests.

## Important behaviour

- `Templates` takes the **first** registered renderer for an extension. A second `@Injectable(TemplateRenderer)` class with `.pdf` is never picked while `PdfRenderer` is registered.
- `DI.unregister(PdfRenderer)` removes it from every key, including its own class key. Register your subclass `.as(PdfRenderer)` so code that resolves `PdfRenderer` directly, like the `render-pdf` CLI and `@spinajs/queue-templates-pdf`, gets it too.
- The renderer in the `Templates` list is resolved without constructor options. `PdfRenderer` there prints with Puppeteer's default `PDFOptions`; `ImageRenderer` takes a PNG with default `ScreenshotOptions`.
- The inherited `__checkInstance__()` compares `instanceOptions` with the **whole** options array the container passes (`[options]`), so it never matches when you resolve with options. `DI.resolve(PdfRenderer, [opts])` therefore builds a new renderer, with its own Chromium, on every call after the first, and only the first one is cached and closed by `DI.dispose()`. Keep the instance you resolve and `dispose()` it yourself, or override `__checkInstance__()` as in the thumbnail example.
- Give constructor options a default. `Templates` resolves the renderer without options; when that happens first, its instance is the one cached for later `DI.resolve()` calls to match against.
- `Extension` doubles as `ServiceName`. Two renderers with the same extension are indistinguishable for code that maps renderers by name.
- `performRender()` runs after `page.setContent()` resolves, ie. after the `load` event. Wait for anything your page draws later (`page.waitForFunction()`, `page.waitForSelector()`).
- `renderToFile()` always compiles `<name>.pug`. To use another engine, compile the HTML yourself and call `renderHtmlToFile()`, or override `renderToFile()`.

## Best practices

- Give every renderer its own config key and `@Config()` property; the base class reads nothing else.
- Use `this.Log` (logger `puppeteer-templates`) in your hooks so render logs stay together.
- Call `super.dispose()` from any `dispose()` override; it closes the pooled browser.
- Keep `performRender()` to the output step. Page setup belongs in a `prepare` wrapper or `configurePageTimeouts()`, so `renderToFile()` and `renderHtmlToFile()` both get it.

## Patterns and antipatterns

```ts
// Don't: a second `.pdf` renderer next to PdfRenderer is never picked by Templates
@Injectable(TemplateRenderer)
class BrandedPdfRenderer extends PdfRenderer {}

// Do: take the shipped renderer out first
@Injectable(TemplateRenderer)
class BrandedPdfRenderer extends PdfRenderer {}
DI.unregister(PdfRenderer);
DI.register(BrandedPdfRenderer).as(PdfRenderer);
```

```ts
// Don't: page setup inside performRender runs after the content and its requests loaded
protected async performRender(page: Page, filePath: string) {
  await page.setRequestInterception(true);
  await page.pdf({ path: filePath });
}

// Do: set the page up in a prepare wrapper, before setContent()
protected renderContentToFile(filePath, opts, prepare) {
  return super.renderContentToFile(filePath, opts, async (page, port, markLoading) => {
    await page.setRequestInterception(true);
    await prepare(page, port, markLoading);
  });
}
```

## Related

- [Rendering to files](01-rendering-to-files.md): the flow your subclass plugs into.
- [Browser pool](04-browser-pool.md) and [Local asset server](05-local-asset-server.md): the two collaborators you can swap through getters.
- [`@spinajs/templates`](../templates/README.md): `TemplateRenderer` and how `Templates` picks a renderer.
- [`@spinajs/templates-pdf`](../templates-pdf/README.md) and [`@spinajs/templates-image`](../templates-image/README.md): the shipped subclasses.
- [`@spinajs/di` lifetimes](../di/04-lifetimes.md): `@PerInstanceCheck()` and `IInstanceCheck`.
