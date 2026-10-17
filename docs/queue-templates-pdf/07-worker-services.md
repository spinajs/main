# Worker services

`renderPdfToProvider()` resolves four kinds of services from the worker's DI container: the configuration, the template engines, the PDF renderer and the output file provider. Each one is replaceable or extendable by registering your class in the worker before the render starts.

## How it works

1. `DI.resolve(Configuration)`: `FrameworkConfiguration`, or `WorkerConfiguration` when the request has `config`.
2. `FsBootsrapper.bootstrap()` registers the `'__file_provider__'` factory; `DI.resolve(fsService)` creates every provider in `fs.providers` from the classes registered as `'fs'`.
3. `DI.resolve(Templates)`: it collects every `TemplateRenderer` and picks one by the template's file extension.
4. `DI.resolve(PdfRenderer, [req.pdfOptions ?? {}])`: the class registered under `PdfRenderer`, one instance per distinct `pdfOptions`.
5. `getFs(req.output.provider)`: the provider instance published under that name.

All of them live in the **worker's** container. Registrations made in the app process do not reach it; make them in a [custom worker entry](06-custom-worker-entry.md), or in a module it imports.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| PDF renderer | `PdfRenderer` (class token), `PerInstanceCheck` by `JSON.stringify(pdfOptions)`; resolved per render | `PdfRenderer` (`@spinajs/templates-pdf`) | Your subclass | `DI.register(MyPdfRenderer).as(PdfRenderer)` in the worker; override `performRender()` |
| Template engine | `TemplateRenderer`, collected by `Templates` (`@Autoinject(TemplateRenderer)`), chosen by `Extension` | Pug (`.pug`, `@spinajs/templates-pug`) | Handlebars (`.handlebars`), MJML and others from their packages; your engine | Import the package in the worker, or register `@Injectable(TemplateRenderer)` with a new `Extension` |
| Template service | `Templates`, singleton | `Templates` (`@spinajs/templates`) | Your subclass | `DI.register(MyTemplates).as(Templates)`; rarely needed |
| Output provider | `'__file_provider__'` factory over `'__file_provider_instance__'`, by name; provider classes `'fs'`, `PerInstanceCheck` per `name` | `fsNative`, `fsTemp` (`@spinajs/fs`) | `fsS3` (`@spinajs/fs-s3`), `fsFTP` (`@spinajs/fs-ftp`), `fsOneDrive` (`@spinajs/fs-onedrive`), your provider | Import the provider package in the worker; select it with `service` in `fs.providers`; name it in `output.provider` |
| Worker configuration | `Configuration`, singleton | `FrameworkConfiguration`; `WorkerConfiguration` when `config` is set | Your `FrameworkConfiguration` subclass | `DI.register(MyConfig).as(Configuration)` in the worker; or `config` per job |

### `PdfRenderer`: custom implementation

Subclass `PdfRenderer` to change how the page becomes a PDF. `performRender(page, filePath)` runs after the content and its resources loaded, inside the renderer's timeout and progress handling; `this.pdfOptions` holds the job's `pdfOptions`. Repeat `@PerInstanceCheck()` so each `pdfOptions` set keeps its own pooled browser.

```ts sample
// src/workers/fonts-ready-pdf-renderer.ts, imported by the PDF worker entry
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { Page } from 'puppeteer';

// Waits for web fonts, so headings are never printed in a fallback font.
@PerInstanceCheck()
export class FontsReadyPdfRenderer extends PdfRenderer {
  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.emulateMediaType('print');
    await super.performRender(page, filePath);
  }
}

DI.register(FontsReadyPdfRenderer).as(PdfRenderer);
```

Import the module at the top of your worker entry, before the `process.on('message')` handler. The registration applies to the next `DI.resolve(PdfRenderer, ...)`, so it must run before the first render.

### Template engines beyond Pug

The shipped worker compiles `.pug` only. Import an engine package in your worker to add its extension, or register your own `TemplateRenderer`: implement `Type`, `Extension`, `render()` and `renderToFile()`.

```ts sample
// src/workers/placeholder-html-renderer.ts, imported by the PDF worker entry
import { writeFile } from 'fs/promises';
import { Injectable } from '@spinajs/di';
import { TemplateRenderer } from '@spinajs/templates';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Plain HTML files with {{ key }} placeholders, for documents a designer edits without Pug.
@Injectable(TemplateRenderer)
export class PlaceholderHtmlRenderer extends TemplateRenderer {
  public get Type(): string {
    return 'placeholder-html';
  }

  public get Extension(): string {
    return '.html';
  }

  public async render(templatePath: string, model: unknown): Promise<string> {
    const source = await this.resolveContent(this.normalizeTemplate(templatePath));
    const values = (model ?? {}) as Record<string, unknown>;

    return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => String(values[key] ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]));
  }

  public async renderToFile(templatePath: string, model: unknown, filePath: string): Promise<void> {
    await writeFile(filePath, await this.render(templatePath, model));
  }
}
```

With the module imported in the worker, `scheduleRenderPdf({ input: 'templates/receipt.html', template: true, model: { total: '42.00' }, ... })` compiles through it.

### Output provider: any fs backend

`output.provider` names an entry of `fs.providers`. The worker creates every entry, so each entry's `service` class must be registered in the worker: `fsNative` and `fsTemp` always are; others need their package imported. A custom provider is a subclass of `fs` or `fsNative` (see [`@spinajs/fs` custom providers](../fs/06-custom-providers.md)).

```ts sample
// src/workers/versioned-documents-fs.ts, imported by the PDF worker entry
// config: fs.providers: [{ service: 'VersionedDocumentsFs', name: 'documents', basePath: '/var/app/documents' }]
import { DateTime } from 'luxon';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsNative, IFsLocalOptions } from '@spinajs/fs';

// Keeps the previous PDF when a render overwrites a path, eg. a re-issued invoice.
@Injectable('fs')
@PerInstanceCheck()
export class VersionedDocumentsFs extends fsNative<IFsLocalOptions> {
  public async upload(srcPath: string, destPath?: string): Promise<void> {
    if (destPath && (await this.exists(destPath))) {
      await this.rename(destPath, `${destPath}.${DateTime.now().toFormat('yyyyLLddHHmmss')}.bak`);
    }

    await super.upload(srcPath, destPath);
  }
}
```

### Worker configuration

The worker loads the app's configuration by default. Two ways to change it:

- Per job: set `config` in the payload. It is merged over the loaded configuration; see [Render worker](03-render-worker.md#configuration-modes).
- For every render: register a `FrameworkConfiguration` subclass in your worker entry. `onLoad()` is merged over the config files.

```ts sample
// src/workers/pdf-worker-configuration.ts, imported by the PDF worker entry
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

// Chromium in the worker gets its own launch flags; the app keeps its defaults.
class PdfWorkerConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      templates: {
        pdf: {
          args: { headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] },
          renderTimeout: 90000,
        },
      },
    };
  }
}

DI.register(PdfWorkerConfiguration).as(Configuration);
```

A job with `config` still replaces this registration: `renderPdfToProvider()` registers its `WorkerConfiguration` last, and it extends `FrameworkConfiguration`, not your class.

## Important behaviour

- `PdfRenderer` instances are pooled by `pdfOptions`. In the shipped worker the process ends after one render, so the pool lives for one job.
- `PdfRenderer` is also registered as a `TemplateRenderer` (type `pdf`, extension `.pdf`). Registering a subclass as `PdfRenderer` changes what `renderPdfToProvider()` uses, not the `TemplateRenderer` list.
- A template engine is chosen by the extension of `input`. Two engines with the same `Extension` make the choice depend on registration order.
- Template `input` is a local path (relative to the working directory) or an `fs://<provider>/<path>` URI read through a provider.
- `fsService` fails the whole worker on any provider it cannot create, even one the render does not use.

## Best practices

- Keep worker-only services in modules the worker entry imports, not in the app's main module: the consumer process does not need Chromium tweaks.
- Use the per-job `config` for values that change per document (a timeout, a port range), and a configuration class for worker-wide settings.
- Test a custom `PdfRenderer` with `renderPdfToProvider()` from a script (see [Render worker](03-render-worker.md#examples)) before wiring it into the queue.

## Patterns and antipatterns

```ts
// Don't: register worker services in the app; the forked worker never sees them
DI.register(FontsReadyPdfRenderer).as(PdfRenderer); // in src/app.ts
await queue.consume(RenderPdfJob);

// Do: register them in the worker entry the job forks
// src/workers/pdf-worker.ts
import './fonts-ready-pdf-renderer.js';
```

## Examples

### A worker entry that wires all of the above

```ts sample
// src/workers/pdf-worker.ts
import '@spinajs/fs-s3';
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { IRenderRequest, renderPdfToProvider, WorkerMessage } from '@spinajs/queue-templates-pdf';
import { Page } from 'puppeteer';

@PerInstanceCheck()
class PrintMediaPdfRenderer extends PdfRenderer {
  protected async performRender(page: Page, filePath: string): Promise<void> {
    await page.emulateMediaType('print');
    await super.performRender(page, filePath);
  }
}

DI.register(PrintMediaPdfRenderer).as(PdfRenderer);

function send(message: WorkerMessage): void {
  process.send?.(message);
}

process.on('message', async (req: IRenderRequest) => {
  let code = 0;
  try {
    send({ type: 'done', result: await renderPdfToProvider(req, send) });
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    code = 1;
  }

  await DI.dispose().catch(() => undefined);
  process.exit(code);
});
```

## Related

- [Custom worker entry](06-custom-worker-entry.md): forking the worker that registers these services.
- [Render worker](03-render-worker.md): the order in which the worker resolves them.
- [`@spinajs/templates-pdf`](../templates-pdf/README.md): `PdfRenderer` and its `templates.pdf` keys.
- [`@spinajs/templates`](../templates/README.md): `TemplateRenderer` and `Templates`.
- [`@spinajs/fs`](../fs/README.md): providers, `getFs()` and the `'__file_provider__'` factory.
- [`@spinajs/configuration`](../configuration/README.md): `FrameworkConfiguration` and its sources.
