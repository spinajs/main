# `@spinajs/templates-xlsx`

Renders Excel `.xlsx` templates to `.xlsx` files. The package adds one engine, `XlsxRenderer`, to the `@spinajs/templates` renderer list; you call it through the `Templates` facade like any other engine. Cell placeholders and loops come from [`xlsx-renderer`](https://www.npmjs.com/package/xlsx-renderer), the workbook I/O from [`exceljs`](https://www.npmjs.com/package/exceljs).

It does **not** render to memory: `render()` and `compile()` reject with `NotSupported`; only `renderToFile()` and `compileToFile()` work. It does **not** read `fs://` URIs, does **not** cache templates, does **not** create the output folder and ignores `language` and `onProgress`. [Custom XLSX renderer](02-custom-xlsx-renderer.md) shows how to add any of these.

## Install

```sh
npm install @spinajs/templates-xlsx
```

## Features

| Feature | What it does |
| --- | --- |
| [Rendering XLSX files](01-rendering-xlsx-files.md) | `Templates.renderToFile()` with a `.xlsx` template: the flow, template cell syntax, errors and limits. |
| [Custom XLSX renderer](02-custom-xlsx-renderer.md) | The `TemplateRenderer` slot `XlsxRenderer` fills: replace it, subclass it, add `fs://` sources or custom cell commands. |

## Quick start

Import the package once so its `@Injectable(TemplateRenderer)` decorator runs, then render through `Templates`:

```ts sample
import '@spinajs/templates-xlsx';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';

export async function exportMonthlySales(month: string, rows: { region: string; total: number }[]): Promise<string> {
  const templates = await DI.resolve(Templates);
  const output = `./exports/sales-${month}.xlsx`;

  await templates.renderToFile('./templates/sales-report.xlsx', { month, rows }, output);

  return output;
}
```

## Extension points at a glance

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| XLSX engine | `TemplateRenderer` (list element) and `XlsxRenderer`, singleton; registered by `@Injectable(TemplateRenderer)` when the module is imported | `XlsxRenderer` | none shipped | `DI.unregister(XlsxRenderer)` then `DI.register(MyRenderer).as(TemplateRenderer)`, before the first `DI.resolve(Templates)`; see [02](02-custom-xlsx-renderer.md) |
| Cell command set | not in DI; `new Renderer()` from `xlsx-renderer` inside `renderToFile()` | `xlsx-renderer`'s default `CellTemplatePool` | your `CellTemplatePool` subclass | override `renderToFile()` and pass the pool to `new Renderer(pool)`; see [02](02-custom-xlsx-renderer.md#add-a-custom-cell-command) |

## Related packages

- [`@spinajs/templates`](../templates/README.md): the `Templates` facade, the `TemplateRenderer` base class and `IRenderOptions`.
- [`@spinajs/di`](../di/README.md): how `@Injectable(Base)` plugins land in a list, see [Multiple implementations](../di/06-multiple-implementations.md).
- [`@spinajs/exceptions`](../exceptions/README.md): `IOFail` and `NotSupported`, the errors this renderer throws.
- [`@spinajs/log`](../log/README.md): the `renderer` logger the engine traces to.
