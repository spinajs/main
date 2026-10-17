# Customizing the PDF renderer

Subclass `PdfRenderer` to change how a page becomes a PDF: wait for fonts, stamp a watermark, apply house defaults, fail on missing assets. Then register the subclass where its consumers look for it: under `TemplateRenderer` for `Templates`, under `PdfRenderer` for code that resolves the class.

## How it works

1. Importing `@spinajs/templates-pdf` runs `@Injectable(TemplateRenderer)` on `PdfRenderer`: `DI.register(PdfRenderer).as(TemplateRenderer)` and `DI.register(PdfRenderer).asSelf()`.
2. `Templates` injects `@Autoinject(TemplateRenderer) Renderers` (an `Array.ofType` list) and picks the **first** renderer whose `Extension` is `.pdf`. The list is cached after its first resolve.
3. `DI.resolve(PdfRenderer, [pdfOptions])`, used by `render-pdf` and by `@spinajs/queue-templates-pdf`, takes the **last** registration under `PdfRenderer`.
4. Every render runs `PuppeteerRenderer.renderContentToFile()`, which calls the protected hooks below. A subclass overrides any of them and calls `super` to keep the default.

| Consumer | Resolves | Picks | To swap in your subclass |
| --- | --- | --- | --- |
| `Templates.renderToFile('x.pdf')`, `Templates.compileToFile(..., 'pdf')` | `Array.ofType(TemplateRenderer)` | First with `Extension === '.pdf'` / `Type === 'pdf'` | `DI.unregister(PdfRenderer)` and register the subclass under `TemplateRenderer`, before the first `Templates` resolve |
| `render-pdf`, `renderPdfToProvider()` (queue worker), your code | `PdfRenderer` | Last registration | `DI.register(MyPdfRenderer).as(PdfRenderer)` before the first resolve |

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Injectable(TemplateRenderer)` | class | the base to register under | Adds the class to the `TemplateRenderer` list and registers it as self |
| `@PerInstanceCheck()` | class | none | One cached instance, matched by `__checkInstance__()`; repeat it on every subclass |
| `@Config('templates.pdf')` | property `Options` | config path, `{ defaultValue }` | Injects the renderer options; redeclare it to read another key |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `.pdf` engine of `Templates` | `TemplateRenderer` list, `@PerInstanceCheck` | `PdfRenderer` | Your subclass | `DI.unregister(PdfRenderer)` + `@Injectable(TemplateRenderer)` on the subclass |
| PDF renderer by class | `PdfRenderer`, `@PerInstanceCheck`, resolved with `[PDFOptions]` | `PdfRenderer` | Your subclass | `DI.register(MyPdfRenderer).as(PdfRenderer)` |
| Render hooks | Protected methods of `PuppeteerRenderer` and `PdfRenderer` | See the table below | none | Override, call `super` |

### Hooks you can override

| Hook | Runs | Default | Override to |
| --- | --- | --- | --- |
| `performRender(page, filePath)` | After the content loaded, in phase `rendering` | `page.pdf({ path: filePath, ...pdfOptions })` | Wait for fonts or scripts, inject CSS, change PDF options, post-process the file |
| `addPageEventListeners(page)` returns a cleanup function | After the page opens | Logs console lines, page errors, responses and failed requests | Collect failures, forward page logs, record metrics |
| `configurePageTimeouts(page)` | After the page opens; skipped with `debug.close: false` | Navigation and default timeouts from config | Set viewport, emulate media, per-document timeouts |
| `armRenderWatchdog(page)` returns a cancel function | After the page opens; skipped with `debug.close: false` | Closes the page after `renderTimeoutMs` | Another timeout policy, alerts |
| `renderTimeoutMs` (getter) | By the two hooks above | `templates.pdf.renderTimeout` or `30000` | Compute the timeout per instance |
| `injectBaseHref(html, baseUrl)` | HTML mode, before `setContent()` | Inserts `<base href>` unless the HTML has one | Rewrite asset URLs, eg. to a CDN |
| `warnIfSlow(filePath, duration)` | After every render | `warn` log above `renderDurationWarning` | Emit a metric |
| `closePage(page)` | After every render, unless `debug.close: false` | `page.close()`, errors logged as `warn` | Keep pages for a pool |
| `instanceOptions` (getter), `__checkInstance__(options)` | On resolve, by `@PerInstanceCheck` | `pdfOptions`, JSON comparison | Change renderer identity; see [Renderer instances](03-renderer-instances-and-pdf-options.md#renderer-identity-share-one-renderer-per-option-set) |
| `renderToFile()`, `renderHtmlToFile()`, `renderContentToFile()` | Entry points and orchestration | Template mode with Pug, HTML mode | Support another source engine, add steps around the whole render |
| `dispose()` | `DI.dispose()` for cached instances, or your call | Closes the pooled browser | Release your own resources, then call `super.dispose()` |

### Apply `templates.pdf.options` to every render

The shipped config has a `templates.pdf.options` key that nothing reads. This subclass merges it under each instance's `pdfOptions`, and replaces `PdfRenderer` for both kinds of consumer, so `Templates.renderToFile('x.pdf')` prints A4 with backgrounds.

```ts sample
// src/pdf/configured-pdf-renderer.ts, imported before the app resolves Templates
import { Config } from '@spinajs/configuration';
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { TemplateRenderer } from '@spinajs/templates';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { Page, PDFOptions } from 'puppeteer';

// config: templates.pdf.options = { format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm' } }
@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class ConfiguredPdfRenderer extends PdfRenderer {
  @Config('templates.pdf.options', { defaultValue: {} })
  protected DefaultPdfOptions: PDFOptions;

  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.pdf({ ...this.DefaultPdfOptions, ...this.pdfOptions, path: filePath });
  }
}

// removes PdfRenderer from the TemplateRenderer list and from its own key
DI.unregister(PdfRenderer);
// DI.resolve(PdfRenderer, [...]) in the CLI and the queue worker now builds ConfiguredPdfRenderer
DI.register(ConfiguredPdfRenderer).as(PdfRenderer);
```

`path` is spread last here, so `pdfOptions` can no longer redirect the output file.

### Replace `PdfRenderer` for code that resolves it by class

Register a subclass under `PdfRenderer` only, and `Templates` keeps the stock renderer. Here every PDF made by the queue worker and by `render-pdf` carries a draft watermark on staging.

```ts sample
// src/pdf/draft-pdf-renderer.ts, imported by the worker entry / CLI module on staging
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { Page } from 'puppeteer';

@PerInstanceCheck()
export class DraftPdfRenderer extends PdfRenderer {
  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.addStyleTag({
      content: `body::after {
        content: 'DRAFT'; position: fixed; top: 40%; left: 10%;
        font-size: 120px; color: rgba(200, 0, 0, 0.15); transform: rotate(-30deg);
      }`,
    });
    await super.performRender(page, filePath);
  }
}

if (process.env.APP_ENV === 'staging') {
  DI.register(DraftPdfRenderer).as(PdfRenderer);
}
```

### Replace the PDF engine of `Templates`

`Templates` takes the first `.pdf` renderer in the list, and `PdfRenderer` registered first. Adding a second `.pdf` renderer has no effect until `PdfRenderer` leaves the list:

```ts
@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class BrandedPdfRenderer extends PdfRenderer { /* ... */ }

DI.unregister(PdfRenderer); // before the first DI.resolve(Templates)
```

`DI.unregister(PdfRenderer)` also removes it from its own key; register your subclass `.as(PdfRenderer)` too when CLI or worker code resolves the class.

## Important behaviour

- Repeat `@PerInstanceCheck()` on every subclass. A subclass that ends up a singleton keeps the `PDFOptions` of whoever resolved it first.
- Keep `Extension` as `.pdf` and `Type` as `pdf` in a replacement for `Templates`: lookups go by those values.
- The `Templates` renderer list is cached on first resolve. Registrations and `DI.unregister()` after that do not change which renderer `Templates` uses.
- `performRender()` runs inside the timeout watchdog: waits there count against `renderTimeout`.
- `renderToFile()` always compiles a sibling `.pug` file. Override it, or compile elsewhere and call `renderHtmlToFile()`, for any other source engine.
- `addPageEventListeners()` must return a function that removes everything it added; pages are closed, but listeners on a kept-open debug page stay.

## Best practices

- Call `super.performRender()` instead of copying `page.pdf()`: the subclass keeps working when the base adds options.
- Put the registration in the module that declares the subclass, and import that module at the top of the entry point (app, CLI module, worker).
- Merge your defaults **under** `this.pdfOptions`, so per-call options still win.

## Patterns and antipatterns

```ts
// Don't: Templates still finds PdfRenderer first, the subclass is never used for .pdf paths
@Injectable(TemplateRenderer)
export class BrandedPdfRenderer extends PdfRenderer {}

// Do: take the stock renderer out of the list, keep the lifetime decorator
@Injectable(TemplateRenderer)
@PerInstanceCheck()
export class BrandedPdfRenderer extends PdfRenderer {}
DI.unregister(PdfRenderer);
```

## Examples

### Fail the render when an image or stylesheet is missing

A PDF with a broken logo is worse than no PDF. This renderer records failed and `4xx`/`5xx` asset requests per page and refuses to print.

```ts sample
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { HTTPRequest, HTTPResponse, Page } from 'puppeteer';

@PerInstanceCheck()
export class StrictPdfRenderer extends PdfRenderer {
  protected missingAssets = new WeakMap<Page, string[]>();

  protected addPageEventListeners(page: Page): () => void {
    const missing: string[] = [];
    this.missingAssets.set(page, missing);

    const onFailed = (request: HTTPRequest) => missing.push(request.url());
    const onResponse = (response: HTTPResponse) => {
      if (response.status() >= 400) {
        missing.push(`${response.status()} ${response.url()}`);
      }
    };
    page.on('requestfailed', onFailed);
    page.on('response', onResponse);

    const removeDefaults = super.addPageEventListeners(page);
    return () => {
      page.off('requestfailed', onFailed);
      page.off('response', onResponse);
      removeDefaults();
    };
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    const missing = this.missingAssets.get(page) ?? [];
    if (missing.length > 0) {
      throw new Error(`Refusing to print ${filePath}, missing assets: ${missing.join(', ')}`);
    }

    // web fonts load after the load event; print only with the real fonts
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await super.performRender(page, filePath);
  }
}

export async function printContract(html: string, output: string): Promise<void> {
  const renderer = await DI.resolve(StrictPdfRenderer, [{ format: 'A4', printBackground: true }]);
  try {
    await renderer.renderHtmlToFile(html, output, { assetBasePath: './templates/contracts' });
  } finally {
    await renderer.dispose();
  }
}
```

### Send render durations to metrics

```ts
@PerInstanceCheck()
export class MeasuredPdfRenderer extends PdfRenderer {
  protected warnIfSlow(filePath: string, duration: number): void {
    metrics.histogram('pdf_render_ms').observe(duration);
    super.warnIfSlow(filePath, duration);
  }
}
```

## Related

- [Renderer instances and PDF options](03-renderer-instances-and-pdf-options.md): lifetimes and `PDFOptions`.
- [Writing a Puppeteer renderer](07-writing-a-puppeteer-renderer.md): a new output format on the same base.
- [`@spinajs/queue-templates-pdf` worker services](../queue-templates-pdf/07-worker-services.md#pdfrenderer-custom-implementation): the same subclassing inside the render worker.
- [`@spinajs/di` multiple implementations](../di/06-multiple-implementations.md): list resolution and `DI.unregister()`.
