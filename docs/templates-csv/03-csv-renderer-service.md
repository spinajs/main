# Extending and replacing the CSV renderer

`Csv` is an ordinary `TemplateRenderer` in DI. Subclass it to add another delimited format or to pre-process rows, or unregister it and register your own `TemplateRenderer` for `.csv`. `Templates` finds every renderer through DI, so callers keep using `render('x.csv', ...)` or `compile(x, 'csv', ...)` unchanged.

## How it works

1. Importing `@spinajs/templates-csv` runs `@Injectable(TemplateRenderer)` on `Csv`. That calls `DI.register(Csv).as(TemplateRenderer)` and `DI.register(Csv).asSelf()`.
2. `Csv` has no lifetime decorator, so it is a singleton: one instance in the container that registered it.
3. When `Templates` is resolved, `@Autoinject(TemplateRenderer) Renderers` injects every registered `TemplateRenderer` (`Array.ofType(TemplateRenderer)`), `Csv` among them.
4. On each call `Templates` takes the **first** renderer in that list whose `Extension` equals the template's extension (`render`, `renderToFile`) or whose `Type` equals the requested type (`compile`, `compileToFile`).
5. The chosen renderer's `render()` or `renderToFile()` runs; see [Rendering CSV](01-rendering-csv.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| CSV renderer | `TemplateRenderer` (list element) and `Csv`; singleton; registered by `@Injectable(TemplateRenderer)` at import | `Csv` (`Type` `csv`, `Extension` `.csv`) | none shipped | Replace: `DI.unregister(Csv)`, then register your `TemplateRenderer` with `Extension` `.csv`, before `Templates` is first resolved. Extend: subclass `Csv` |
| Another delimited format | `TemplateRenderer`, your class, singleton | none | TSV, Excel CSV, pipe-separated | `@Injectable(TemplateRenderer)` on a `Csv` subclass with its own `Type`, `Extension` and `@Config` path |
| Format options | `Csv.Options`, `@Config('templates.csv')` getter | `templates.csv` | another config path | Redeclare `Options` in a subclass with your own `@Config(path, { defaultValue })` |

### Overridable members of `Csv`

| Member | Visibility | Default | Override to |
| --- | --- | --- | --- |
| `Type` | public getter | `'csv'` | name the renderer for `compile(template, type, ...)` |
| `Extension` | public getter | `'.csv'` | match another file extension in `render(template, ...)`; also the `ServiceName` |
| `Options` | protected, `@Config('templates.csv')` | the config section | read another section or add defaults |
| `Log` | protected, `@Logger('csv-templates')` | logger `csv-templates` | redeclare with `@Logger('<name>')` for a separate log channel |
| `render(template, model, language?)` | public | validate, build `AsyncParser`, return the CSV | shape `model.data` before `super.render()`, post-process the string |
| `renderToFile(template, model, filePath, language?)` | public | `render()`, create parent dirs, write UTF-8 | write elsewhere (fs provider, stream) |

`renderToFile()` calls `this.render()`, so a `render()` override applies to both.

Members inherited from `TemplateRenderer` that `Csv` does not use: `withCache()`, `resolveContent()`, `resolveLocalPath()`, `changeToken()` and the `templates.cache.mode` setting. A renderer that reads real template files uses them; see [`@spinajs/templates`](../templates/README.md).

### Add a TSV renderer

Subclass `Csv`, give it its own `Type` and `Extension`, and point `Options` at its own section with a tab as the default delimiter. `Csv` keeps serving `.csv`.

```ts sample
import '@spinajs/templates-csv';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { Csv } from '@spinajs/templates-csv';

@Injectable(TemplateRenderer)
export class Tsv extends Csv {
  @Config('templates.tsv', { defaultValue: { delimiter: '\t', eol: '\n' } })
  protected Options: any;

  public get Type() {
    return 'tsv';
  }

  public get Extension() {
    return '.tsv';
  }
}

async function exportStock(): Promise<string> {
  const templates = await DI.resolve(Templates);

  // '.tsv' selects Tsv; '.csv' would still select Csv.
  return templates.render('stock.tsv', {
    fields: ['sku', 'warehouse', 'qty'],
    data: [{ sku: 'A-1', warehouse: 'WRO', qty: 12 }],
  });
}

void exportStock().then((tsv) => console.log(tsv));
// "sku"	"warehouse"	"qty"
// "A-1"	"WRO"	12
```

### A renderer reachable only by type

`compile()` and `compileToFile()` look renderers up by `Type`, so a second CSV dialect can sit beside `Csv` without a file extension of its own. Give it an `Extension` no template name uses.

```ts sample
import '@spinajs/templates-csv';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { Csv } from '@spinajs/templates-csv';

@Injectable(TemplateRenderer)
export class ExcelCsv extends Csv {
  @Config('templates.excelCsv', {
    defaultValue: {
      delimiter: ';',
      eol: '\r\n',
      withBOM: true,
      formatters: { number: (value: number) => `${value}`.replace('.', ',') },
    },
  })
  protected Options: any;

  public get Type() {
    return 'excel-csv';
  }

  public get Extension() {
    return '.excel-csv';
  }
}

async function payrollForAccounting(rows: { employee: string; gross: number }[]): Promise<void> {
  const templates = await DI.resolve(Templates);

  // The file is still named .csv; the type picks ExcelCsv, not Csv.
  await templates.compileToFile('payroll', 'excel-csv', { fields: ['employee', 'gross'], data: rows }, 'exports/payroll-2026-10.csv');
}

void payrollForAccounting([{ employee: 'Anna Nowak', gross: 8450.5 }]);
```

### Mask personal data before every export

Override `render()` to shape the rows, then call `super.render()`. Replace `Csv` with the subclass so every `.csv` render goes through it.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { Csv, IJsonToCsvOptions } from '@spinajs/templates-csv';

const PERSONAL_FIELDS = ['email', 'phone', 'pesel'];

function mask(value: unknown): unknown {
  return typeof value === 'string' && value.length > 2 ? `${value.slice(0, 2)}***` : value;
}

@Injectable(TemplateRenderer)
export class MaskingCsv extends Csv {
  public async render(template: string, model: IJsonToCsvOptions, language?: string): Promise<string> {
    if (!Array.isArray(model?.data)) {
      return super.render(template, model, language);
    }

    const data = (model.data as Record<string, unknown>[]).map((row) => {
      const masked = { ...row };
      for (const field of PERSONAL_FIELDS) {
        if (field in masked) {
          masked[field] = mask(masked[field]);
        }
      }
      return masked;
    });

    return super.render(template, { ...model, data }, language);
  }
}

// Csv and MaskingCsv both answer '.csv'; remove Csv so the lookup cannot pick it.
DI.unregister(Csv);

async function customersExport(): Promise<string> {
  const templates = await DI.resolve(Templates);
  return templates.render('customers.csv', {
    fields: ['id', 'name', 'email'],
    data: [{ id: 1, name: 'Anna Nowak', email: 'anna@example.com' }],
  });
}

void customersExport().then((csv) => console.log(csv));
// "id","name","email"
// 1,"Anna Nowak","an***"
```

### Replace the CSV renderer

Write your own `TemplateRenderer` when json2csv does not fit, eg. to stream a large export to disk row by row instead of building one string. Implement `Type`, `Extension`, `render()` and `renderToFile()`, unregister `Csv`, and register yours before `Templates` is first resolved.

```ts sample
import { createWriteStream } from 'fs';
import { once } from 'events';
import { DI, Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { TemplateRenderer, Templates, ensureParentDir } from '@spinajs/templates';
import { Csv, IJsonToCsvOptions } from '@spinajs/templates-csv';

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function* lines(model: IJsonToCsvOptions): Generator<string> {
  if (!model || !Array.isArray(model.fields) || !Array.isArray(model.data)) {
    throw new InvalidArgument('csv render model requires { fields: string[], data: object[] }');
  }

  yield model.fields.map(cell).join(',');
  for (const row of model.data as Record<string, unknown>[]) {
    yield model.fields.map((f) => cell(row[f])).join(',');
  }
}

@Injectable(TemplateRenderer)
export class StreamingCsv extends TemplateRenderer {
  public get Type() {
    return 'csv';
  }

  public get Extension() {
    return '.csv';
  }

  public async render(_template: string, model: IJsonToCsvOptions): Promise<string> {
    return [...lines(model)].join('\r\n');
  }

  public async renderToFile(_template: string, model: IJsonToCsvOptions, filePath: string): Promise<void> {
    ensureParentDir(filePath);
    const out = createWriteStream(filePath, 'utf8');

    for (const line of lines(model)) {
      if (!out.write(`${line}\r\n`)) {
        await once(out, 'drain');
      }
    }

    out.end();
    await once(out, 'finish');
  }
}

// Before the first DI.resolve(Templates): Templates captures the renderer list when it is built.
DI.unregister(Csv);

async function nightlyLedger(entries: { date: string; account: string; amount: number }[]): Promise<void> {
  const templates = await DI.resolve(Templates);
  await templates.renderToFile('ledger.csv', { fields: ['date', 'account', 'amount'], data: entries }, 'exports/ledger.csv');
}

void nightlyLedger([{ date: '2026-10-16', account: '700-01', amount: -120 }]);
```

## Important behaviour

- With two renderers for one extension or type, `Templates` takes the first in the injected list, and the order of an async list is not something to rely on. Unregister the one you replace.
- `DI.unregister(Csv)` removes `Csv` from every key it is registered under, `TemplateRenderer` and `Csv`. It does not drop an instance already built, nor the list `Templates` already holds: do it before `Templates` is first resolved.
- The registry skips a second class with the **same name** under one key. A replacement class named `Csv` is ignored while the original `Csv` is registered; give your class another name.
- A subclass inherits the `@Config` and `@Logger` getters of `Csv`. Redeclaring `Options` with a new `@Config` path gives the subclass its own section; `Csv` keeps `templates.csv`.
- `Extension` doubles as `ServiceName` (`IMappableService`); keep it unique among renderers.
- A subclass decorated with `@Injectable(TemplateRenderer)` adds a renderer; it does not replace `Csv`. Only `DI.unregister(Csv)` removes the original.

## Best practices

- Prefer a `Csv` subclass with its own `Type` over changing `templates.csv` when the app needs two CSV dialects.
- Validate the model the way `Csv.render()` does and throw `InvalidArgument`, so callers get the same error for a bad model whichever renderer runs.
- Keep a replacement's `Type` as `csv` so `compile(x, 'csv', ...)` call sites keep working.
- Register and unregister renderers in the module that bootstraps templates, next to the import of `@spinajs/templates-csv`.

## Patterns and antipatterns

```ts
// Don't: both answer '.csv'; which one runs depends on list order
@Injectable(TemplateRenderer)
class MyCsv extends Csv {}

// Do: remove the original when you mean to replace it
@Injectable(TemplateRenderer)
class MyCsv extends Csv {}
DI.unregister(Csv);
```

```ts
// Don't: same class name as the original; the registry ignores it while Csv is registered
@Injectable(TemplateRenderer)
class Csv extends TemplateRenderer { /* ... */ }

// Do: a distinct name
@Injectable(TemplateRenderer)
class StreamingCsv extends TemplateRenderer { /* ... */ }
```

## Related

- [Rendering CSV](01-rendering-csv.md): the flow the renderer plugs into.
- [CSV format options](02-csv-format-options.md): the options a subclass inherits or redeclares.
- [`@spinajs/templates`](../templates/README.md): `TemplateRenderer`, `Templates` lookup, caching helpers for file-based renderers.
- [`@spinajs/di` multiple implementations](../di/06-multiple-implementations.md): list injection behind `Templates.Renderers`.
- [`@spinajs/di` registering services](../di/01-registering-services.md): `@Injectable(Base)` and `DI.unregister()`.
