# Custom XLSX renderer

`XlsxRenderer` fills the `.xlsx` slot of the `TemplateRenderer` list that `Templates` dispatches to. Replace it or subclass it to report progress, return the workbook in memory, or add your own cell commands.

## How it works

1. Importing `@spinajs/templates-xlsx` runs `@Injectable(TemplateRenderer)` on `XlsxRenderer`. It registers the class under the `TemplateRenderer` key and under its own name, `XlsxRenderer`.
2. `Templates` declares `@Autoinject(TemplateRenderer) Renderers: TemplateRenderer[]`. When `Templates` is first resolved, DI builds every class registered under `TemplateRenderer`, in registration order, as singletons.
3. `Templates.renderToFile()` and `render()` take the **first** renderer whose `Extension` equals the template's extension. `compile()` and `compileToFile()` take the first whose `Type` equals the requested name.
4. Your renderer therefore wins only when `XlsxRenderer` is removed from the list (`DI.unregister(XlsxRenderer)`), or when it claims an extension and type no other renderer uses.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| XLSX engine | `TemplateRenderer` list element and `XlsxRenderer`; singleton (no lifetime decorator); registered by `@Injectable(TemplateRenderer)` at module import | `XlsxRenderer` | none shipped | Replace: `DI.unregister(XlsxRenderer)`, then `DI.register(MyRenderer).as(TemplateRenderer)`. Extend: subclass `XlsxRenderer` and override `renderToFile()` or `render()` |
| Cell command set | not in DI; `new Renderer()` is created inside `XlsxRenderer.renderToFile()` | `xlsx-renderer`'s `CellTemplatePool` | your `CellTemplatePool` subclass | Override `renderToFile()` and call `new Renderer(myPool)` |
| Renderer lookup | `Templates`, singleton, from `@spinajs/templates` | `Templates` | | Reads `Extension` and `Type` of each renderer; a renderer with a new `Extension` and `Type` is added next to `XlsxRenderer` without replacing it |

### What a subclass can use

| Member | From | Use |
| --- | --- | --- |
| `Type`, `Extension` | `XlsxRenderer` | `'xlsx'` and `'.xlsx'`; override both to add a second engine instead of replacing this one |
| `renderToFile(template, model, filePath, language?, options?)` | `XlsxRenderer` | Validates the path, renders, writes; call `super.renderToFile()` after preparing the inputs |
| `render(template, model, language?, options?)` | `XlsxRenderer` | Rejects with `NotSupported`; override it to return content |
| `resolveLocalPath(template)` | `TemplateRenderer` | Returns a bare path as is; downloads an `fs://` URI through `@spinajs/fs` and returns the local copy |
| `isUri(template)`, `withCache(template, compile)` | `TemplateRenderer` | URI test and the `templates.cache.mode` cache, unused by `XlsxRenderer` |
| `Log` | `TemplateRenderer` | The `renderer` logger |
| `ensureParentDir(filePath)` | `@spinajs/templates` export | Creates the output folder |

### When to register

- Register after `@spinajs/templates-xlsx` is imported, or `DI.unregister(XlsxRenderer)` has nothing to remove and the decorator adds it back later.
- Register before the first `DI.resolve(Templates)`. `Templates` is a singleton and keeps the renderer array it was built with.
- Do not decorate a replacement with `@Injectable(TemplateRenderer)` while `XlsxRenderer` is still registered: both claim `.xlsx` and `Templates` keeps using `XlsxRenderer`, the first one registered.

### Report progress

Subclass `XlsxRenderer` when you keep its rendering and add steps around it. This one reports a final progress snapshot to `options.onProgress`.

```ts sample
import { DI } from '@spinajs/di';
import { IRenderOptions, RenderPhase, TemplateRenderer, Templates } from '@spinajs/templates';
import { XlsxRenderer } from '@spinajs/templates-xlsx';

export class FsXlsxRenderer extends XlsxRenderer {
  public async renderToFile(template: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    const startedAt = Date.now();
    await super.renderToFile(template, model, filePath, language);

    const callback = options?.onProgress;
    if (callback) {
      // fire and forget, as the IRenderOptions contract requires
      Promise.resolve()
        .then(() =>
          callback({
            phase: RenderPhase.Done,
            percent: 100,
            resourcesLoaded: 0,
            resourcesPending: 0,
            resourcesFailed: 0,
            elapsedMs: Date.now() - startedAt,
            filePath,
          }),
        )
        .catch(() => undefined);
    }
  }
}

DI.unregister(XlsxRenderer);
DI.register(FsXlsxRenderer).as(TemplateRenderer);

export async function exportTenantPayroll(tenant: string, month: string, rows: { employee: string; gross: number }[]): Promise<string> {
  const templates = await DI.resolve(Templates);
  const output = `./exports/${tenant}/payroll-${month}.xlsx`;

  await templates.renderToFile('fs://templates/payroll.xlsx', { tenant, month, rows }, output, undefined, {
    onProgress: (p) => console.log(`payroll ${month}: ${p.phase} in ${p.elapsedMs} ms`),
  });

  return output;
}
```

### Return the workbook from `render()`

`render()` must return a `string`. Return the workbook as base64 when the caller needs the bytes without a file, for example to put them in an API response or an email attachment.

```ts sample
import { DI } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { XlsxRenderer } from '@spinajs/templates-xlsx';
import { Renderer } from 'xlsx-renderer';
import { existsSync } from 'fs';

export class InMemoryXlsxRenderer extends XlsxRenderer {
  public async render(template: string, model: unknown): Promise<string> {
    if (!existsSync(template)) {
      throw new IOFail(`File for template at path ${template} not exists`);
    }

    const workbook = await new Renderer().renderFromFile(template, model);
    const bytes = await workbook.xlsx.writeBuffer();

    return Buffer.from(bytes).toString('base64');
  }
}

DI.unregister(XlsxRenderer);
DI.register(InMemoryXlsxRenderer).as(TemplateRenderer);

export async function invoiceAttachment(invoiceNo: string, lines: { item: string; amount: number }[]): Promise<Buffer> {
  const templates = await DI.resolve(Templates);
  const base64 = await templates.render('./templates/invoice.xlsx', { invoiceNo, lines });

  return Buffer.from(base64, 'base64');
}
```

`renderToFile()` still comes from `XlsxRenderer`, so file rendering is unchanged.

### Add a custom cell command

`xlsx-renderer` matches every template cell against the cell classes in a `CellTemplatePool`, first match wins. Subclass the pool to add a command, and pass it to `new Renderer(pool)` in your own `renderToFile()`. `XlsxRenderer` has no hook for the pool, so the override replaces the whole method. The pool and cell classes are not exported from the `xlsx-renderer` entry; import them from `xlsx-renderer/lib/...`.

This command writes a number as a formatted amount: `#! MONEY invoice.total PLN`.

```ts sample
import { DI } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { XlsxRenderer } from '@spinajs/templates-xlsx';
import { Renderer } from 'xlsx-renderer';
import { CellTemplatePool } from 'xlsx-renderer/lib/CellTemplatePool.js';
import { BaseCell } from 'xlsx-renderer/lib/cell/BaseCell.js';
import { Scope } from 'xlsx-renderer/lib/Scope.js';
import { Cell, ValueType } from 'exceljs';
import { existsSync } from 'fs';

class MoneyCell extends BaseCell {
  public static match(cell: Cell): boolean {
    return !!cell && cell.type === ValueType.String && typeof cell.value === 'string' && cell.value.startsWith('#! MONEY ');
  }

  public apply(scope: Scope): MoneyCell {
    super.apply(scope);

    const [, , path, currency = 'EUR'] = scope.getCurrentTemplateString().split(' ');
    const value = path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), scope.vm);
    const text = typeof value === 'number' ? new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(value) : null;

    scope.setCurrentOutputValue(text);
    scope.incrementCol();
    return this;
  }
}

class InvoiceCellPool extends CellTemplatePool {
  constructor() {
    super();
    this.cells.unshift(MoneyCell);
  }
}

export class InvoiceXlsxRenderer extends XlsxRenderer {
  public async renderToFile(template: string, model: unknown, filePath: string): Promise<void> {
    if (!existsSync(template)) {
      throw new IOFail(`File for template at path ${template} not exists`);
    }

    // a fresh pool per render: the pool caches one instance per cell class
    const workbook = await new Renderer(new InvoiceCellPool()).renderFromFile(template, model);

    ensureParentDir(filePath);
    await workbook.xlsx.writeFile(filePath);
  }
}

DI.unregister(XlsxRenderer);
DI.register(InvoiceXlsxRenderer).as(TemplateRenderer);

export async function renderInvoice(invoiceNo: string, total: number): Promise<void> {
  const templates = await DI.resolve(Templates);
  await templates.renderToFile('./templates/invoice.xlsx', { invoice: { no: invoiceNo, total } }, `./out/invoice-${invoiceNo}.xlsx`);
}
```

### Add a second engine next to `XlsxRenderer`

Give a subclass its own `Type` to keep `XlsxRenderer` and add a variant you pick by name with `compileToFile()`. This variant creates the output folder for nightly exports; every other `.xlsx` render keeps the default engine.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { XlsxRenderer } from '@spinajs/templates-xlsx';

@Injectable(TemplateRenderer)
export class NightlyExportRenderer extends XlsxRenderer {
  public get Type() {
    return 'xlsx-nightly';
  }

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    ensureParentDir(filePath);
    await super.renderToFile(template, model, filePath, language);
  }
}

export async function nightlyStockExport(date: string, items: { sku: string; qty: number }[]): Promise<void> {
  const templates = await DI.resolve(Templates);
  await templates.compileToFile('./templates/stock.xlsx', 'xlsx-nightly', { date, items }, `./exports/${date}/stock.xlsx`);
}
```

`Extension` stays `.xlsx`, so `Templates.renderToFile('./templates/stock.xlsx', ...)` still reaches `XlsxRenderer`, registered first. Override `Extension` too when the variant owns its own file type.

## Important behaviour

- Lookups use `Array.prototype.find()` over the renderer list: with two renderers on one extension or type, the first registered wins and the other is never called.
- `DI.unregister(XlsxRenderer)` removes the class from every key it is registered under, `TemplateRenderer` and `XlsxRenderer` alike.
- A renderer registered after `Templates` was resolved is not seen by that `Templates` instance.
- Renderers are singletons shared by all renders. Keep per-render state in local variables, not in fields; the `xlsx-renderer` `Renderer` and its pool are created per call for the same reason.
- `Templates` still wraps your renderer in the `Perf` span and applies `options.redact` to errors it throws.

## Best practices

- Subclass `XlsxRenderer` and call `super.renderToFile()` when you only add steps before or after rendering; it keeps the `IOFail` check and the trace logs.
- Keep the `IOFail` path check in an override that replaces `renderToFile()`, so a missing template fails the same way as with the default engine.
- Return a different `Type` and `Extension` when the new engine handles a different file format; replace `XlsxRenderer` only when you change how `.xlsx` renders.

## Patterns and antipatterns

```ts
// Don't: XlsxRenderer is registered first, so Templates keeps calling it for '.xlsx'
@Injectable(TemplateRenderer)
export class BetterXlsxRenderer extends XlsxRenderer {}

// Do: remove the default, then register the replacement
export class BetterXlsxRenderer extends XlsxRenderer {}
DI.unregister(XlsxRenderer);
DI.register(BetterXlsxRenderer).as(TemplateRenderer);
```

```ts
// Don't: Templates already holds its renderer array
const templates = await DI.resolve(Templates);
DI.unregister(XlsxRenderer);
DI.register(BetterXlsxRenderer).as(TemplateRenderer);

// Do: register first, resolve after
DI.unregister(XlsxRenderer);
DI.register(BetterXlsxRenderer).as(TemplateRenderer);
const templates = await DI.resolve(Templates);
```

## Related

- [Rendering XLSX files](01-rendering-xlsx-files.md): the default flow, template syntax and limits.
- [`@spinajs/templates`](../templates/README.md): the `TemplateRenderer` base class and `Templates` lookup.
- [Multiple implementations](../di/06-multiple-implementations.md): how `@Injectable(Base)` lists are built and cached.
- [`@spinajs/fs`](../fs/README.md): the providers `fs://` template URIs resolve through.
