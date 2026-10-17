# `@spinajs/templates-csv`

A CSV renderer for [`@spinajs/templates`](../templates/README.md). It registers `Csv`, a `TemplateRenderer` for the `.csv` extension and the `csv` type, which turns a list of field names and rows into CSV text with [`@json2csv/node`](https://www.npmjs.com/package/@json2csv/node).

It does **not** read template files. The template name only selects the renderer; the columns and rows come from the model. It does **not** stream to the caller: the whole CSV is built in memory and returned as one string, or written to a file in one go.

## Install

```sh
npm install @spinajs/templates-csv
```

It needs `@spinajs/templates` and a resolved `Configuration`, which a normal SpinaJS bootstrap provides.

## Features

| Feature | What it does |
| --- | --- |
| [Rendering CSV](01-rendering-csv.md) | `Templates.render()`, `renderToFile()`, `compile()` and `compileToFile()` with a `.csv` name or the `csv` type; the `IJsonToCsvOptions` model, accepted data shapes, field paths, errors |
| [CSV format options](02-csv-format-options.md) | The `templates.csv` config section: delimiter, line ending, header, BOM, default value, transforms and formatters for every render |
| [Extending and replacing the CSV renderer](03-csv-renderer-service.md) | `Csv` in DI: add a renderer for another format or type (TSV, Excel CSV), pre-process rows, or replace the `.csv` renderer with your own `TemplateRenderer` |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| The `.csv` / `csv` renderer | `TemplateRenderer` (and `Csv`), singleton, registered by `@Injectable(TemplateRenderer)` when the package is imported | `Csv` | [Extending and replacing](03-csv-renderer-service.md#replace-the-csv-renderer) |
| Another delimited format | Your `Csv` subclass under `TemplateRenderer`, own `Type` and `Extension` | none | [Extending and replacing](03-csv-renderer-service.md#add-a-tsv-renderer) |
| Row pre-processing | `Csv.render()` override in a subclass | rows passed as given | [Extending and replacing](03-csv-renderer-service.md#mask-personal-data-before-every-export) |
| Format options | `Csv.Options`, read from `templates.csv` on every render | json2csv defaults | [CSV format options](02-csv-format-options.md) |
| Cell and header formatting | `templates.csv.formatters`, `templates.csv.transforms` | json2csv formatters | [CSV format options](02-csv-format-options.md#formatters-and-transforms) |

## Quick start

```ts sample
import '@spinajs/templates-csv';
import { DI } from '@spinajs/di';
import { Templates } from '@spinajs/templates';
import { IJsonToCsvOptions } from '@spinajs/templates-csv';

interface Order {
  id: number;
  customer: string;
  total: number;
}

async function exportOrders(orders: Order[]): Promise<string> {
  const templates = await DI.resolve(Templates);

  const model: IJsonToCsvOptions = {
    fields: ['id', 'customer', 'total'],
    data: orders,
  };

  // The `.csv` extension picks the Csv renderer; no file named orders.csv is read.
  return templates.render('orders.csv', model);
}

void exportOrders([{ id: 1, customer: 'ACME', total: 120.5 }]).then((csv) => console.log(csv));
// "id","customer","total"
// 1,"ACME",120.5
```

## Related packages

- [`@spinajs/templates`](../templates/README.md): `Templates`, `TemplateRenderer` and renderer selection by extension or type.
- [`@spinajs/configuration`](../configuration/README.md): where the `templates.csv` section comes from.
- [`@spinajs/di`](../di/README.md): `@Injectable(Base)`, list injection and `DI.unregister()`, used to add or replace renderers.
- [`@spinajs/log`](../log/README.md): the `csv-templates` logger and the `template.render` / `template.compile` perf spans.
