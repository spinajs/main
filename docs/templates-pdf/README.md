# `@spinajs/templates-pdf`

Renders Pug templates and raw HTML to PDF files through headless Chromium (Puppeteer). It adds `PdfRenderer`, a `TemplateRenderer` for the `.pdf` extension, the `templates.pdf` configuration and the `render-pdf` CLI command.

It does **not** render to a string: `PdfRenderer.render()` throws `NotSupported`. It does **not** compile templates itself: the template is compiled by the Pug renderer of [`@spinajs/templates-pug`](../templates-pug/README.md). Background rendering in a worker process lives in [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/README.md).

## Install

```sh
npm install @spinajs/templates-pdf
```

Puppeteer downloads Chromium on install. Where it cannot, point `templates.pdf.executablePath` at an installed Chrome; see [Renderer configuration](02-renderer-configuration.md).

Importing the package registers `PdfRenderer` in DI and, through `@spinajs/templates-puppeteer`, the Pug renderer. Its config file (`lib/<mjs|cjs>/config/pdf.js`) is picked up by `@spinajs/configuration` from `node_modules/@spinajs/*`.

## Features

| Feature | What it does |
| --- | --- |
| [Rendering PDFs](01-rendering-pdfs.md) | `Templates.renderToFile()` with a `.pdf` path, `PdfRenderer.renderToFile()` and `renderHtmlToFile()`: the render flow, asset loading, errors |
| [Renderer configuration](02-renderer-configuration.md) | The `templates.pdf` keys: Chromium launch options, asset server ports, timeouts, slow-render warning, debug mode |
| [Renderer instances and PDF options](03-renderer-instances-and-pdf-options.md) | Puppeteer `PDFOptions` per renderer, `@PerInstanceCheck` pooling, the pooled browser and `dispose()` |
| [Render progress](04-render-progress.md) | `onProgress` snapshots, phases and percent bands, the in-page `__spinajs_progress__:` protocol |
| [`render-pdf` command](05-render-pdf-command.md) | `spinajs render-pdf`: HTML or a template to PDF from the command line or CI |
| [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md) | Subclass `PdfRenderer`, override its hooks and replace it under `TemplateRenderer` or `PdfRenderer` |
| [Writing a Puppeteer renderer](07-writing-a-puppeteer-renderer.md) | Build a sibling renderer on the abstract `PuppeteerRenderer` base |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| The `.pdf` engine of `Templates` | `TemplateRenderer`, resolved as a list by `Templates`; `@PerInstanceCheck` | `PdfRenderer` | [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#replace-the-pdf-engine-of-templates) |
| The renderer resolved by class | `PdfRenderer` (registered as self), resolved with `[PDFOptions]` by the CLI and by `@spinajs/queue-templates-pdf` | `PdfRenderer` | [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#replace-pdfrenderer-for-code-that-resolves-it-by-class) |
| Render hooks | Protected methods of `PuppeteerRenderer`: `performRender()`, `configurePageTimeouts()`, `addPageEventListeners()`, `injectBaseHref()`, `armRenderWatchdog()`, `warnIfSlow()` | Implemented in `PuppeteerRenderer` / `PdfRenderer` | [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#hooks-you-can-override) |
| Renderer identity | `instanceOptions` getter and `__checkInstance__()` (`IInstanceCheck`) | `JSON.stringify(pdfOptions)` | [Renderer instances and PDF options](03-renderer-instances-and-pdf-options.md) |
| Sibling renderers | Abstract `PuppeteerRenderer` from `@spinajs/templates-puppeteer`, registered under `TemplateRenderer` | `PdfRenderer`, `ImageRenderer` (`@spinajs/templates-image`) | [Writing a Puppeteer renderer](07-writing-a-puppeteer-renderer.md) |
| Renderer options | Config key `templates.pdf` (`IPuppeteerRendererOptions`) | The package config file | [Renderer configuration](02-renderer-configuration.md) |
| Progress | `IRenderOptions.onProgress` callback and the page console protocol | none | [Render progress](04-render-progress.md) |
| CLI command | `RenderPdfCommand`, found through `system.dirs.cli` | `render-pdf` | [`render-pdf` command](05-render-pdf-command.md) |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-pdf';

async function printInvoice() {
  await DI.resolve(Configuration);
  const templates = await DI.resolve(Templates);

  // compiles ./templates/invoice.pug, prints it to ./out/invoice-2026-117.pdf
  await templates.renderToFile('./templates/invoice.pdf', { number: 'FV/2026/117', total: 1230 }, './out/invoice-2026-117.pdf', 'en');

  // closes the pooled Chromium so the process can exit
  await DI.dispose();
}

void printInvoice();
```

## Related packages

- [`@spinajs/templates`](../templates/README.md): the `Templates` facade and the `TemplateRenderer` contract `PdfRenderer` implements.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): `PuppeteerRenderer`, the base class with the browser pool, asset server and progress reporter.
- [`@spinajs/templates-pug`](../templates-pug/README.md): compiles the `.pug` template before it is printed.
- [`@spinajs/templates-image`](../templates-image/README.md): the screenshot sibling of `PdfRenderer`, built on the same base.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/README.md): renders PDFs in a worker process as a queue job.
- [`@spinajs/cli`](../cli/README.md): runs the `render-pdf` command.
- [`@spinajs/di`](../di/README.md): `@Injectable`, `@PerInstanceCheck` and `DI.unregister()` used to replace the renderer.
