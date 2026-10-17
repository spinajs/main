# Custom image renderers

`ImageRenderer` is an open class: subclass it to change how the screenshot is taken, to serve a new file extension through `Templates`, or to replace the default `.png` renderer everywhere. Every step of the render is a protected method you can override.

## How it works

1. `ImageRenderer` is decorated `@Injectable(TemplateRenderer)` and `@PerInstanceCheck()`. `@Injectable` registers it twice: in the `TemplateRenderer` list and under its own class name.
2. `Templates` injects the whole `TemplateRenderer` list when it is first resolved, and picks a renderer by `Extension` (`renderToFile`, `render`) or by `Type` (`compileToFile`, `compile`). The first match in registration order wins.
3. `DI.resolve(ImageRenderer, [options])` takes the last class registered under `ImageRenderer`. The `render-image` command resolves it this way.
4. A subclass decorated `@Injectable(TemplateRenderer)` joins the list next to `ImageRenderer`. `DI.unregister(ImageRenderer)` removes the default from both registrations.
5. Each render calls the protected hooks of `PuppeteerRenderer` in this order: `assetServer`, `browserPool`, `armRenderWatchdog()`, `configurePageTimeouts()`, `addPageEventListeners()`, the content step, `performRender()`, the listener cleanup, `warnIfSlow()`, `closePage()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Engine in the `Templates` list | `TemplateRenderer` list, each element `@PerInstanceCheck()`; resolved once, when `Templates` is first resolved | `ImageRenderer` (`.png`, `image`) | `PdfRenderer` (`@spinajs/templates-pdf`); your subclasses | Add: `@Injectable(TemplateRenderer)` on a subclass with a new `Extension`. Replace: `DI.unregister(ImageRenderer)` before the first `DI.resolve(Templates)`, plus the subclass |
| Renderer resolved by class | `ImageRenderer` key, `@PerInstanceCheck()`; resolved on each `DI.resolve(ImageRenderer, [options])` | `ImageRenderer` | none | `DI.register(MySubclass).as(ImageRenderer)` before the first resolve; in a CLI, in your own entry point before `DI.resolve(Cli)` |
| Screenshot step | `performRender(page, filePath)`, protected | `page.screenshot({ path: filePath, ...screenshotOptions })` | `PdfRenderer` calls `page.pdf()` | Override; call `super.performRender()` to keep the default capture |
| Instance identity | `instanceOptions` getter and `__checkInstance__(creationOptions)` | `instanceOptions` returns `screenshotOptions`; `__checkInstance__` compares its JSON with the JSON of the whole options array | none | Override `__checkInstance__` to compare with `creationOptions?.[0]` ([example](#reuse-one-renderer-per-option-set)) |
| Options section | `Options`, a `@Config('templates.image')` getter typed `IPuppeteerRendererOptions` | `templates.image` | `templates.pdf` in `PdfRenderer` | Redeclare `Options` with another `@Config` path ([example](#give-a-renderer-its-own-config-section)) |
| Page hooks | Protected methods inherited from `PuppeteerRenderer` | See the table below | none | Override, and call `super` to keep the default behaviour |
| Abstract base | `PuppeteerRenderer` from `@spinajs/templates-puppeteer`, not registered itself | `ImageRenderer`, `PdfRenderer` | none | Extend it for a non-image output; see [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md) |

### Overridable members

| Member | Default | Override to |
| --- | --- | --- |
| `Type` | `'image'` | Select the renderer by name in `Templates.compileToFile(template, '<type>', ...)` |
| `Extension` | `.<screenshotOptions.type>` or `.png` | Serve another template extension through `Templates`; one segment only (`.webp`, not `.card.png`), since `Templates` matches `extname()` |
| `performRender(page, filePath)` | Full screenshot with `screenshotOptions` | Wait for fonts, crop to an element, validate the page, write extra outputs |
| `addPageEventListeners(page)` | Logs `console`, `pageerror`, `response`, `requestfailed`; returns a cleanup function | Collect errors per page, block or count requests |
| `configurePageTimeouts(page)` | Navigation and default timeouts from `Options` | Per-renderer timeouts; not called when `debug.close` is `false` |
| `armRenderWatchdog(page)` | Closes the page after `renderTimeout`; returns a cancel function | A different watchdog; not called when `debug.close` is `false` |
| `injectBaseHref(html, baseUrl)` | Inserts `<base href>` unless the HTML has one | Rewrite asset URLs in raw HTML differently |
| `warnIfSlow(filePath, duration)` | Warns above `renderDurationWarning` | Send a metric instead |
| `closePage(page)` | Closes the page, logs close errors as warnings | Keep pages for a pool of your own |
| `renderContentToFile(filePath, opts, prepare)` | The shared render sequence | Add a new public method that prepares the page differently |
| `assetServer`, `browserPool` | Lazily created `LocalAssetServer` and `BrowserPool` | Supply your own server or browser source |
| `dispose()` | Closes the pooled browser | Release your own resources; call `super.dispose()` |

### Add a renderer for a new extension

Render Open Graph cards as WebP, cropped to the `.og-card` element, with their own config section. `templates.renderToFile('templates/og/launch.webp', ...)` compiles `templates/og/launch.pug` and picks this renderer by its `.webp` extension.

```ts sample
import { Page, ScreenshotOptions } from 'puppeteer';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { IPuppeteerRendererOptions } from '@spinajs/templates-puppeteer';
import { ImageRenderer } from '@spinajs/templates-image';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class OgCardRenderer extends ImageRenderer {
  @Config('templates.ogCard')
  protected Options: IPuppeteerRendererOptions;

  public get Type() {
    return 'og-card';
  }

  public get Extension() {
    return '.webp';
  }

  constructor(screenshotOptions?: ScreenshotOptions) {
    super({ type: 'webp', quality: 85, ...screenshotOptions });
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.setViewport({ width: 1200, height: 630 });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const card = await page.$('.og-card');
    if (!card) {
      throw new Error(`Template for ${filePath} has no .og-card element`);
    }

    await card.screenshot({ ...this.screenshotOptions, path: filePath });
  }
}

async function publishLaunchCard(): Promise<void> {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  await templates.renderToFile('templates/og/launch.webp', { title: 'SpinaJS 3 is out' }, 'public/og/launch.webp');
}

void publishLaunchCard();
```

### Give a renderer its own config section

Redeclaring `Options` with `@Config('templates.ogCard')`, as above, makes the subclass read its own section. The section has no defaults: add it to your config.

```js
export default {
  templates: {
    ogCard: {
      static: { portRange: [] },
      args: { headless: true },
      renderDurationWarning: 3000,
      renderTimeout: 15000,
    },
  },
};
```

Without the section, `Options` is `undefined`: Chromium launches with Puppeteer's defaults, the OS picks the asset server port, timeouts are `30000` ms, and no slow-render warning is logged.

### Replace the default `.png` renderer

Refuse to save a broken image: fail the render when an asset did not load or a page script threw, and wait for web fonts first. Unregister `ImageRenderer` and register the subclass under its token, so `Templates`, your code and the `render-image` command all use it.

```ts sample
import { HTTPRequest, Page } from 'puppeteer';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { ImageRenderer } from '@spinajs/templates-image';

@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class StrictImageRenderer extends ImageRenderer {
  private readonly problems = new WeakMap<Page, string[]>();

  protected addPageEventListeners(page: Page): () => void {
    const problems: string[] = [];
    this.problems.set(page, problems);

    const onRequestFailed = (request: HTTPRequest) => problems.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
    const onPageError = (error: Error) => problems.push(`script error: ${error.message}`);

    page.on('requestfailed', onRequestFailed);
    page.on('pageerror', onPageError);
    const removeDefaultListeners = super.addPageEventListeners(page);

    return () => {
      page.off('requestfailed', onRequestFailed);
      page.off('pageerror', onPageError);
      removeDefaultListeners();
    };
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const problems = this.problems.get(page) ?? [];
    if (problems.length > 0) {
      throw new Error(`Not saving ${filePath}: ${problems.join('; ')}`);
    }

    await super.performRender(page, filePath);
  }
}

// Before the first DI.resolve(Templates): drop the default from both registrations, route the class token here.
DI.unregister(ImageRenderer);
DI.register(StrictImageRenderer).as(ImageRenderer);

async function renderInvoiceImage(invoiceNo: string): Promise<void> {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  await templates.renderToFile('templates/invoices/invoice.png', { invoiceNo }, `out/invoices/${invoiceNo}.png`);
}

void renderInvoiceImage('FV-2026-0042');
```

### Reuse one renderer per option set

`DI.resolve(ImageRenderer, [options])` builds a new renderer, and a new Chromium, on every call, because the shipped `__checkInstance__` compares the stored options with the whole options array. Compare with its first element to get one renderer per distinct option set.

```ts sample
import { DI, PerInstanceCheck } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ImageRenderer } from '@spinajs/templates-image';

@PerInstanceCheck()
export class PooledImageRenderer extends ImageRenderer {
  public __checkInstance__(creationOptions: unknown[] | undefined): boolean {
    return JSON.stringify(this.instanceOptions) === JSON.stringify(creationOptions?.[0]);
  }
}

DI.register(PooledImageRenderer).as(ImageRenderer);

async function renderThumbnails(pages: { html: string; file: string }[]): Promise<void> {
  await DI.resolve(Configuration);

  for (const page of pages) {
    // Same options on every call: one renderer, one Chromium for the whole batch.
    const renderer = await DI.resolve(ImageRenderer, [{ type: 'jpeg', quality: 70 }]);
    await renderer.renderHtmlToFile(page.html, page.file, { viewport: { width: 320, height: 240 } });
  }

  await DI.dispose();
}

void renderThumbnails([{ html: '<h1>Pricing</h1>', file: 'thumbs/pricing.jpeg' }]);
```

`PooledImageRenderer` is not decorated `@Injectable(TemplateRenderer)`, so `Templates` keeps the shipped `ImageRenderer` for `.png` templates.

## Important behaviour

- **Register before `Templates` is resolved.** `Templates` builds its renderer list once. A subclass imported, or an `unregister()` run, after the first `DI.resolve(Templates)` is not seen by that instance.
- **Two renderers with the same `Extension`**: `Templates` uses the first registered, which is `ImageRenderer` when your package loads after it. Unregister the default to replace it.
- **`DI.unregister()` matches by class name.** A subclass also named `ImageRenderer` is removed with the default.
- **Put `@PerInstanceCheck()` on each subclass.** A subclass with no DI decorators of its own inherits the lifetime. One that declares an injected property (`@Config`, `@Autoinject`) gets its own descriptor with the singleton lifetime, and then ignores the options of later resolves.
- **The `Templates` instance gets no constructor options.** Set fixed screenshot options in the subclass constructor, as `OgCardRenderer` does; options passed to `DI.resolve()` reach only the instances you resolve yourself.
- **`renderToFile()` reads `<name>.pug` built from `Extension`.** Keep `Extension` a single segment that matches the template file name you pass.
- **Every override runs inside the render timeout.** Long waits in `performRender()` count toward `renderTimeout`; the watchdog closes the page when it passes.

## Best practices

- Call `super.performRender()` after your checks instead of re-implementing the screenshot, so `screenshotOptions` keep working.
- Return a cleanup function from `addPageEventListeners()` that removes your listeners and calls the one from `super`.
- Keep per-render state in a `WeakMap` keyed by `Page`: one renderer serves concurrent renders.
- Give a subclass with different launch needs its own `@Config` section instead of changing `templates.image` for everyone.

## Patterns and antipatterns

```ts
// Don't: per-render state on the instance; concurrent renders overwrite each other
protected addPageEventListeners(page: Page) {
  this.lastErrors = [];
  page.on('pageerror', (e) => this.lastErrors.push(e.message));
  return super.addPageEventListeners(page);
}

// Do: state per page, and remove your listener in the cleanup
protected addPageEventListeners(page: Page) {
  const errors: string[] = [];
  this.errors.set(page, errors);
  const onError = (e: Error) => errors.push(e.message);
  page.on('pageerror', onError);
  const removeDefault = super.addPageEventListeners(page);
  return () => {
    page.off('pageerror', onError);
    removeDefault();
  };
}
```

```ts
// Don't: a two-segment extension never matches `extname()`
public get Extension() { return '.card.png'; }

// Do: one segment, distinct from the shipped renderers
public get Extension() { return '.webp'; }
```

## Related

- [Image renderer](01-image-renderer.md): the default render flow these hooks plug into.
- [Configuration](02-configuration.md): the `templates.image` section and its keys.
- [`render-image` command](03-render-image-command.md): uses the class registered under `ImageRenderer`.
- [Multiple implementations](../di/06-multiple-implementations.md): how the `TemplateRenderer` list is built and how `unregister()` removes an element.
- [Lifetimes](../di/04-lifetimes.md): `@PerInstanceCheck()` and `IInstanceCheck`.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): `PuppeteerRenderer`, `BrowserPool`, `LocalAssetServer`.
