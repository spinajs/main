# Writing a Puppeteer renderer

`PdfRenderer` is a thin subclass of the abstract `PuppeteerRenderer` from `@spinajs/templates-puppeteer`. Extend the same base to add another Chromium-made output format to `Templates`: you write the last step, the base brings the browser pool, asset server, timeouts, logging and progress.

## How it works

1. Your class extends `PuppeteerRenderer` and implements its abstract members.
2. `@Injectable(TemplateRenderer)` adds it to the list `Templates` searches; its `Extension` and `Type` make it selectable.
3. `Templates.renderToFile('invoice<Extension>', ...)` or `Templates.compileToFile(..., '<Type>', ...)` calls the inherited `renderToFile()`, which compiles the sibling `.pug` and runs the [render flow](01-rendering-pdfs.md#how-it-works).
4. In phase `rendering` the base calls your `performRender(page, filePath)` to write the output.

| Member | Kind | `PdfRenderer` | You provide |
| --- | --- | --- | --- |
| `Options` | abstract property, `IPuppeteerRendererOptions` | `@Config('templates.pdf')` | A `@Config(...)` property; reusing `templates.pdf` is fine |
| `Type` | abstract getter | `'pdf'` | Engine name for `Templates.compileToFile()` |
| `Extension` | abstract getter | `'.pdf'` | Extension `Templates.renderToFile()` matches, and the suffix replaced by `.pug` |
| `performRender(page, filePath)` | abstract method | `page.pdf(...)` | The output step |
| `instanceOptions` | getter, default `undefined` | `pdfOptions` | Only when instances carry options; add `@PerInstanceCheck()` then |
| `render()` | method | throws `NotSupported` | Override only if the format has a string form |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `PuppeteerRenderer` | Abstract; each subclass registers under `TemplateRenderer` | none | `PdfRenderer` (this package), `ImageRenderer` (`@spinajs/templates-image`, screenshots, per `ScreenshotOptions`) | Extend it, implement the four abstract members, decorate `@Injectable(TemplateRenderer)` |
| Renderer options | The `@Config` key your `Options` reads | `templates.pdf` for `PdfRenderer`, `templates.image` for `ImageRenderer` | Your own key | Point `@Config` at it; the [same keys](02-renderer-configuration.md#configuration) apply |

### `PuppeteerRenderer`: archive the exact page a PDF was printed from

An audit trail needs the document as Chromium saw it, with images, fonts and styles inlined. This renderer writes an MHTML archive through the DevTools protocol, from the same Pug templates as the PDFs.

```ts sample
// src/pdf/mhtml-renderer.ts, imported at app start
import { writeFile } from 'fs/promises';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { Templates, TemplateRenderer } from '@spinajs/templates';
import { IPuppeteerRendererOptions, PuppeteerRenderer } from '@spinajs/templates-puppeteer';
import '@spinajs/templates-pdf';
import { Page } from 'puppeteer';

@Injectable(TemplateRenderer)
export class MhtmlRenderer extends PuppeteerRenderer {
  // same Chromium, ports and timeouts as the PDFs
  @Config('templates.pdf')
  protected Options: IPuppeteerRendererOptions;

  public get Type(): string {
    return 'mhtml';
  }

  public get Extension(): string {
    return '.mhtml';
  }

  protected async performRender(page: Page, filePath: string): Promise<void> {
    const cdp = await page.createCDPSession();
    try {
      const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      await writeFile(filePath, data);
    } finally {
      await cdp.detach();
    }
  }
}

export async function issueInvoice(invoice: { number: string; total: number }): Promise<void> {
  const templates = await DI.resolve(Templates);
  const name = invoice.number.replace(/\//g, '-');

  // both compile ./templates/invoice/invoice.pug
  await templates.renderToFile('./templates/invoice/invoice.pdf', invoice, `./storage/invoices/${name}.pdf`);
  await templates.renderToFile('./templates/invoice/invoice.mhtml', invoice, `./storage/audit/${name}.mhtml`);
}
```

## Important behaviour

- A renderer without constructor options needs no `@PerInstanceCheck()`: the default singleton lifetime fits, and `instanceOptions` stays `undefined`.
- Each renderer instance has its own pooled Chromium. `PdfRenderer` and `MhtmlRenderer` above run two browsers; both close on `DI.dispose()`.
- Two renderers with the same `Extension` cannot both serve `Templates.renderToFile()`: the one registered first wins. Pick a unique extension, or `DI.unregister()` the other.
- Template mode always compiles `<name>.pug`; the base adds `__http_template_port__` and `__http_template_address__` to the model.
- `render()` rejects with `NotSupported` unless you override it, so `Templates.render('x.mhtml')` fails.

## Best practices

- Reuse an existing `@Config` key unless the format needs other launch options; one Chromium configuration is easier to run in containers.
- Keep `performRender()` to the output step. Page setup belongs in `configurePageTimeouts()` and `addPageEventListeners()` so it also runs for HTML mode.

## Related

- [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#hooks-you-can-override): every hook the base calls.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): the base class, `BrowserPool`, `LocalAssetServer` and `RenderProgressReporter`.
- [`@spinajs/templates-image`](../templates-image/README.md): the screenshot renderer built on the same base.
- [`@spinajs/templates`](../templates/README.md): the `TemplateRenderer` contract and engine lookup.
