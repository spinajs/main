# Renderer instances and PDF options

A `PdfRenderer` instance carries one set of Puppeteer `PDFOptions` (paper, margins, header, footer) and owns one pooled Chromium. Resolve it with options to choose the page layout; dispose it to close its browser.

## How it works

1. `DI.resolve(PdfRenderer, [pdfOptions])` passes `pdfOptions` to the constructor: `new PdfRenderer(pdfOptions)`. The renderer is an `AsyncService`, so `resolve()` returns a `Promise`.
2. `PdfRenderer` is `@PerInstanceCheck()`. The first instance built in a container is cached under `PdfRenderer`.
3. On a later resolve, DI calls `__checkInstance__(options)` on the cached instance. `PuppeteerRenderer.__checkInstance__()` compares `JSON.stringify(this.instanceOptions)` (the renderer's `pdfOptions`) with `JSON.stringify(options)` (the whole options **array**).
4. A match returns the cached instance. A mismatch builds a new instance that is returned but **not** cached.
5. On the first render, `BrowserPool.acquire()` launches the instance's Chromium. Every later render of the same instance opens a page in it; a crashed or disconnected browser is relaunched.
6. `dispose()` closes the browser: all its pages, then the process, with `SIGKILL` as the fallback.

What a resolve returns, given step 3:

| Call | Returns |
| --- | --- |
| First resolve in the container, with or without options | A new instance, cached |
| `DI.resolve(PdfRenderer)` or the `Templates` list, no options | The cached instance when it was built without options, else a new one |
| `DI.resolve(PdfRenderer, [pdfOptions])` after the first resolve | A new, uncached instance on every call: an object never equals the one-element array it came in |

## Configuration

The `PDFOptions` object is passed per instance, not through config. Common fields (all optional, from Puppeteer):

| Field | Type | Puppeteer default | Meaning |
| --- | --- | --- | --- |
| `format` | `PaperFormat` | `'letter'` | `'A4'`, `'Letter'`, `'Legal'`, `'A3'`, ... |
| `landscape` | `boolean` | `false` | Page orientation |
| `printBackground` | `boolean` | `false` | Print background colours and images |
| `margin` | `{ top, right, bottom, left }` | none | CSS lengths, eg. `'15mm'` |
| `scale` | `number` | `1` | `0.1` to `2` |
| `displayHeaderFooter`, `headerTemplate`, `footerTemplate` | `boolean`, `string`, `string` | `false` | Running header and footer; the templates may use `pageNumber`, `totalPages`, `date`, `title` classes |
| `pageRanges` | `string` | all pages | eg. `'1-3'` |
| `preferCSSPageSize` | `boolean` | `false` | Let `@page { size }` in the template win over `format` |

`PdfRenderer.performRender()` calls `page.pdf({ path: filePath, ...pdfOptions })`. `templates.pdf.options` in config is **not** applied; see [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#apply-templatespdfoptions-to-every-render) to make it so.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Renderer identity | `IInstanceCheck.__checkInstance__()` on `PuppeteerRenderer`, used by `@PerInstanceCheck` | Compares `JSON.stringify(instanceOptions)` with `JSON.stringify(options)` | none | Override `__checkInstance__()` or the protected `instanceOptions` getter in a subclass |
| Browser lifetime | `PuppeteerRenderer.dispose()`, called by `DI.dispose()` for cached instances | Closes the pooled browser, then `AsyncService.dispose()` | none | Override `dispose()` and call `super.dispose()` |

### Renderer identity: share one renderer per option set

Override `__checkInstance__()` to compare against the first element of the options array, so repeated resolves with the same `PDFOptions` reuse the cached renderer and its browser.

```ts sample
import { DI, PerInstanceCheck } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { PDFOptions } from 'puppeteer';

@PerInstanceCheck()
export class SharedPdfRenderer extends PdfRenderer {
  public __checkInstance__(creationOptions: unknown[]): boolean {
    return JSON.stringify(this.instanceOptions ?? {}) === JSON.stringify(creationOptions?.[0] ?? {});
  }
}

const A4: PDFOptions = { format: 'A4', printBackground: true };

export async function printLabels(batches: string[]): Promise<void> {
  for (const html of batches) {
    // every iteration gets the same instance, so Chromium launches once
    const renderer = await DI.resolve(SharedPdfRenderer, [A4]);
    await renderer.renderHtmlToFile(html, `./storage/labels/${Date.now()}.pdf`);
  }

  // closes the cached renderer's browser
  await DI.dispose();
}
```

DI caches only the first instance of a `@PerInstanceCheck()` class, so this shares the option set resolved first. For several presets, keep the instances yourself, as in [Keep one renderer per document preset](#keep-one-renderer-per-document-preset).

## Important behaviour

- Every `DI.resolve(PdfRenderer, [options])` after the first builds a new renderer with its own Chromium, and `DI.dispose()` does not reach it. Call `dispose()` on each renderer you resolve with options, or the Chromium process stays alive.
- A browser launches on the first render, not on resolve. Resolving a renderer you never use costs nothing.
- `pdfOptions` are spread **after** `path`, so a `path` key in them overrides the output file passed to `renderToFile()` / `renderHtmlToFile()`.
- The renderer used by `Templates` is built without options: Puppeteer defaults apply.
- `BrowserPool` shares one launch between concurrent first renders, and retries the launch on the next render after a failure.
- `dispose()` with renders in flight closes their pages; those renders fail.

## Best practices

- Keep long-lived renderers for steady load (an HTTP endpoint printing invoices); dispose per call for one-shot work (CLI, worker processes).
- Define each layout once as a `PDFOptions` constant and reuse it; `JSON.stringify` comparison is key-order sensitive.

## Patterns and antipatterns

```ts
// Don't: a new renderer and a new Chromium per request, never closed
app.get('/invoices/:id.pdf', async (req) => {
  const renderer = await DI.resolve(PdfRenderer, [{ format: 'A4' }]);
  await renderer.renderToFile('./templates/invoice/invoice.pdf', await loadInvoice(req.params.id), out);
});

// Do: build the renderer once, reuse it, dispose it at shutdown
const renderer = await DI.resolve(PdfRenderer, [{ format: 'A4' }]);
app.get('/invoices/:id.pdf', async (req) => {
  await renderer.renderToFile('./templates/invoice/invoice.pdf', await loadInvoice(req.params.id), out);
});
```

## Examples

### Keep one renderer per document preset

```ts sample
import { AsyncService, DI, Singleton } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { PDFOptions } from 'puppeteer';

const PRESETS: Record<'invoice' | 'label' | 'report', PDFOptions> = {
  invoice: { format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '20mm', left: '15mm', right: '15mm' } },
  label: { width: '100mm', height: '150mm', printBackground: true },
  report: {
    format: 'A4',
    landscape: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '10mm', bottom: '15mm' },
  },
};

@Singleton()
export class DocumentPrinter extends AsyncService {
  protected renderers = new Map<keyof typeof PRESETS, PdfRenderer>();

  public async print(preset: keyof typeof PRESETS, html: string, output: string): Promise<void> {
    let renderer = this.renderers.get(preset);
    if (!renderer) {
      renderer = await DI.resolve(PdfRenderer, [PRESETS[preset]]);
      this.renderers.set(preset, renderer);
    }

    await renderer.renderHtmlToFile(html, output);
  }

  // DI.dispose() reaches this singleton, which closes every preset's browser
  public async dispose(): Promise<void> {
    await Promise.all([...this.renderers.values()].map((r) => r.dispose()));
    this.renderers.clear();
  }
}
```

## Related

- [Renderer configuration](02-renderer-configuration.md): launch options of the pooled browser.
- [`@spinajs/di` lifetimes](../di/04-lifetimes.md): `@PerInstanceCheck` and `IInstanceCheck`.
- [`@spinajs/queue-templates-pdf`](../queue-templates-pdf/README.md): resolves `PdfRenderer` with the job's `pdfOptions` in a short-lived worker.
