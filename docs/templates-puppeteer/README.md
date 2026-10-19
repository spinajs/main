# `@spinajs/templates-puppeteer`

The shared Puppeteer engine behind the PDF and image template renderers. `PuppeteerRenderer` compiles a Pug template or takes raw HTML, loads it in a pooled headless Chromium with a local asset server, reports progress, and hands the page to a subclass that writes the file.

It does **not** register a renderer: install [`@spinajs/templates-pdf`](../templates-pdf/README.md) or [`@spinajs/templates-image`](../templates-image/README.md), or write a subclass. It does **not** render to a string: `render()` throws `NotSupported`. `renderToFile()` maps an output path such as `invoice.pdf` to its `.pug` source.

## Install

```sh
npm install @spinajs/templates-puppeteer
```

`puppeteer` downloads a Chromium build on install. Set `executablePath` in the renderer's config when the download is not possible.

## Features

| Feature | What it does |
| --- | --- |
| [Rendering to files](01-rendering-to-files.md) | `renderToFile()` and `renderHtmlToFile()`: the render flow, template variables, configuration, timeouts and debug mode |
| [Render progress](02-render-progress.md) | `onProgress` phases and percent, the in-page `__spinajs_progress__:` protocol, `RenderProgressReporter` for your own Puppeteer code |
| [Custom Puppeteer renderers](03-custom-renderers.md) | Subclass `PuppeteerRenderer`, register it for `Templates`, per-options instances, the protected hooks, replacing `PdfRenderer` |
| [Browser pool](04-browser-pool.md) | `BrowserPool`: one reused Chromium per renderer, relaunch on crash, close on `dispose()`; render in a remote Chrome |
| [Local asset server](05-local-asset-server.md) | `LocalAssetServer`: per-render loopback static server, port range, serving extra asset folders |

## Exports

| Export | Kind | Page |
| --- | --- | --- |
| `PuppeteerRenderer` | abstract class | [Custom Puppeteer renderers](03-custom-renderers.md) |
| `IPuppeteerRendererOptions` | interface | [Rendering to files](01-rendering-to-files.md#configuration) |
| `BrowserPool` | class | [Browser pool](04-browser-pool.md) |
| `LocalAssetServer` | class | [Local asset server](05-local-asset-server.md) |
| `RenderProgressReporter` | class | [Render progress](02-render-progress.md) |
| `parseProgressLine()`, `PAGE_PROGRESS_PREFIX` | function, constant | [Render progress](02-render-progress.md#page-progress-protocol) |

## Quick start

Render an HTML string to a PDF with the subclass from `@spinajs/templates-pdf`:

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { PdfRenderer } from '@spinajs/templates-pdf';

async function printReceipt(): Promise<void> {
  await DI.resolve(Configuration);
  const renderer = await DI.resolve(PdfRenderer, [{ format: 'A5', printBackground: true }]);

  try {
    await renderer.renderHtmlToFile('<h1>Receipt 2026/10/0042</h1><p>Total: 49.90 EUR</p>', 'out/receipt-0042.pdf');
  } finally {
    // closes the pooled Chromium so the process can exit
    await renderer.dispose();
  }
}

void printReceipt();
```

## Related packages

- [`@spinajs/templates`](../templates/README.md): `Templates`, the `TemplateRenderer` base class, `IRenderOptions` and the progress types.
- [`@spinajs/templates-pdf`](../templates-pdf/README.md): `PdfRenderer`, the `.pdf` subclass.
- [`@spinajs/templates-image`](../templates-image/README.md): `ImageRenderer`, the screenshot subclass.
- [`@spinajs/templates-pug`](../templates-pug/README.md): compiles the `.pug` source of `renderToFile()`; this package imports it.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/README.md): renders PDFs in a queue worker and forwards progress to the job.
- [`@spinajs/di`](../di/README.md): `@PerInstanceCheck()`, `@LazyInject()` and list resolution used by the renderers.
