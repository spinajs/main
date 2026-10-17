# `render-pdf` command

`spinajs render-pdf` renders an HTML file, or a template, to a PDF from the command line. Use it in CI to produce documents for review or comparison, and to check a template while you edit it.

```sh
spinajs render-pdf <input> -o <file> [-t] [-m <model.json>] [-l <lang>] [--format <format>] [--landscape] [--scale <scale>]
```

## How it works

1. `@spinajs/cli` finds `RenderPdfCommand` in the directory this package appends to `system.dirs.cli`.
2. `RenderPdfCommand.execute()` resolves `PdfRenderer` with `{ format, landscape, printBackground: true, scale }` built from the options.
3. `resolveInputHtml()` (from `@spinajs/templates`) produces the HTML:
   - raw mode: reads `<input>`; a missing file throws `Input HTML file ... does not exist`;
   - template mode (`-t`): `Templates.render(input, model, lang)`, the engine picked by the input's extension.
4. `ensureParentDir()` creates the output directory.
5. `renderer.renderHtmlToFile(html, output, { assetBasePath: dirname(input), onProgress: cliProgressReporter() })` prints the PDF and the progress line.
6. Success logs at `success` level on the `templates-pdf` logger. A failure logs at `error` and rethrows to `@spinajs/cli`.
7. `renderer.dispose()` always runs and closes Chromium, so the process can exit.

## Arguments and options

| Argument / option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `<input>` | yes | none | An `.html` file, or a template file with `-t` |
| `-o, --output <file>` | yes | none | Output PDF path; its directory is created |
| `-t, --template` | no | off | Render `<input>` through `Templates` first |
| `-m, --model [model]` | no | `{}` | JSON model file, template mode only. A missing file gives `{}` silently |
| `-l, --lang [lang]` | no | none | Language for translations, template mode only |
| `--format [format]` | no | `A4` | Puppeteer paper format: `A4`, `Letter`, `Legal`, `A3`, ... |
| `--landscape` | no | off | Landscape orientation |
| `--scale [scale]` | no | `1` | Rendering scale, `0.1` to `2`, parsed with `parseFloat` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | this package's `lib/<mjs\|cjs>/cli` under `WORKSPACE_ROOT_PATH ?? cwd`, and one directory up | Directory paths | Where `@spinajs/cli` finds `render-pdf` |
| `templates.pdf.*` | | | | Chromium, ports and timeouts; see [Renderer configuration](02-renderer-configuration.md) |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| The command | `RenderPdfCommand`, discovered from `system.dirs.cli`, resolved by `@spinajs/cli`; not exported from the package entry | `RenderPdfCommand` | Your own `CliCommand` | Write a command in your app's CLI directory; see [`@spinajs/cli` commands](../cli/02-commands.md) |
| The renderer it uses | `PdfRenderer`, resolved with `[pdfOptions]` | `PdfRenderer` | Your subclass | `DI.register(MyPdfRenderer).as(PdfRenderer)` in a module your CLI loads; see [Customizing the PDF renderer](06-customizing-the-pdf-renderer.md#replace-pdfrenderer-for-code-that-resolves-it-by-class) |
| The HTML source | `resolveInputHtml()` with `Templates` | Engine by file extension | Any `TemplateRenderer` package you install | Install the engine package; template mode uses it by extension |

### The command: a CI command with project defaults

`RenderPdfCommand` is not exported, so add your own command next to it when CI needs fixed options, eg. margins and a footer.

```ts sample
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { PdfRenderer } from '@spinajs/templates-pdf';
import { Templates, loadJsonModel, ensureParentDir } from '@spinajs/templates';
import { dirname, resolve } from 'path';

interface ContractPreviewOptions {
  output: string;
  model?: string;
}

// src/cli/contract-preview.ts, in a directory listed in system.dirs.cli
@Command('contract:preview', 'Render a contract template with the legal footer, for PR review')
@Argument('template', true, 'path to the contract .pug template')
@Option('-o, --output <file>', true, 'output PDF file path')
@Option('-m, --model [model]', false, 'path to a JSON model file')
export class ContractPreviewCommand extends CliCommand {
  public async execute(template: string, options: ContractPreviewOptions): Promise<void> {
    const templates = await DI.resolve(Templates);
    const html = await templates.render(template, loadJsonModel(options.model), 'pl');

    const renderer = await DI.resolve(PdfRenderer, [
      {
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="font-size:7px;width:100%;text-align:center">Draft - page <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
        margin: { top: '15mm', bottom: '20mm', left: '20mm', right: '20mm' },
      },
    ]);

    try {
      ensureParentDir(options.output);
      await renderer.renderHtmlToFile(html, options.output, { assetBasePath: dirname(resolve(template)) });
    } finally {
      await renderer.dispose();
    }
  }
}
```

## Important behaviour

- The command always sets `printBackground: true`, unlike `Templates.renderToFile()`.
- Template mode renders to HTML first and then uses `renderHtmlToFile()`, so relative asset URLs resolve against the input's directory through the injected `<base href>`. The `.pdf`-named path of [Rendering PDFs](01-rendering-pdfs.md) is not used here: pass the `.pug` (or `.handlebars`, ...) file itself.
- Template mode does not pass `__http_template_address__` to the template; relative URLs are the way to reference assets.
- A model path that does not exist is not an error: the template renders with `{}`.
- `--scale` is not validated: a non-number becomes `NaN` and goes to Puppeteer unchecked.

## Best practices

- Commit a `model.json` next to each template and render it in CI with `-t -m`; a template that stops compiling fails the build.
- Compare the output with a golden image, as `test/visual.test.ts` in this package does with `pdfjs-dist` and `pixelmatch`.

## Examples

### Render a template preview in CI

```sh
spinajs render-pdf ./templates/invoice/invoice.pug -t -m ./templates/invoice/model.json -l pl -o ./artifacts/invoice.pdf
```

### Render a static HTML page in landscape

```sh
spinajs render-pdf ./build/report.html -o ./artifacts/report.pdf --format A3 --landscape --scale 0.8
```

## Related

- [`@spinajs/cli`](../cli/README.md): running commands and command discovery.
- [Render progress](04-render-progress.md): the progress line the command prints.
- [`@spinajs/templates`](../templates/README.md): `resolveInputHtml()`, `loadJsonModel()`, `ensureParentDir()` and `cliProgressReporter()`.
