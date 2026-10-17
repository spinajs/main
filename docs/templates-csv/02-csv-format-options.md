# CSV format options

The `templates.csv` config section sets the CSV format for every render: delimiter, line ending, header row, BOM, default value, row transforms and cell formatters. `Csv` passes the section to json2csv as parser options.

## How it works

1. `Csv.Options` is a `@Config('templates.csv')` property. It has no default, so with no section it is `undefined`.
2. Each `Csv.render()` reads `Options` again; the getter asks the current `Configuration`, so a changed value applies from the next render.
3. `Csv.render()` builds the parser options as `{ fields: model.fields, ...Options }`. Keys from config are applied **after** the model's `fields`.
4. json2csv fills the unset options with its defaults (table below) and converts the rows.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `templates.csv` | object | unset | the keys below | json2csv parser options for every CSV render |
| `templates.csv.delimiter` | `string` | `,` | any string | Separator between cells |
| `templates.csv.eol` | `string` | `os.EOL` (`\r\n` on Windows, `\n` elsewhere) | any string | Separator between lines; no line break follows the last row |
| `templates.csv.header` | `boolean` | `true` | `true`, `false` | Write the header row of `fields` labels |
| `templates.csv.withBOM` | `boolean` | `false` | `true`, `false` | Prefix the output with a UTF-8 BOM (`U+FEFF`); Excel then detects UTF-8 |
| `templates.csv.defaultValue` | any | `undefined` (empty cell) | any value | Cell value for a missing or `undefined` field |
| `templates.csv.includeEmptyRows` | `boolean` | `false` | `true`, `false` | Keep rows whose every cell is empty |
| `templates.csv.ndjson` | `boolean` | `false` | `true`, `false` | Parse string or byte `data` as newline-delimited JSON |
| `templates.csv.transforms` | `((row) => object \| object[])[]` | `[]` | functions | Run on each row before cells are read; returning an array emits several rows |
| `templates.csv.formatters` | object of `(value) => string` | json2csv formatters | keys `header`, `string`, `number`, `boolean`, `bigint`, `undefined`, `symbol`, `function`, `object` | Turn a cell value of that type into text; `header` formats header labels |
| `templates.csv.fields` | `string[]` or json2csv field objects | unset | | **Overrides the model's `fields` for every render.** Leave it unset |

Functions (`transforms`, `formatters`) need a JS or TS config file; a JSON source cannot carry them.

```ts
// config/templates.ts
export default {
  templates: {
    csv: {
      delimiter: ';',
      eol: '\r\n',
      withBOM: true,
      defaultValue: 'n/a',
      formatters: {
        // decimal comma for spreadsheets set to a Polish locale
        number: (value: number) => `${value}`.replace('.', ','),
      },
    },
  },
};
```

## Formatters and transforms

The default formatters, which a `formatters` entry replaces per type:

| Type | Default output |
| --- | --- |
| `string`, `header` | Wrapped in `"`, inner `"` doubled |
| `number` | `${value}` |
| `boolean`, `bigint` | `${value}` |
| `undefined` | empty |
| `object` | `null` gives empty; otherwise `JSON.stringify`, then the `string` formatter |
| `symbol` | the description, then the `string` formatter |

A custom `string` formatter also formats header labels and the text of `object` and `symbol` cells: json2csv builds those defaults from it. Give `header` or `object` its own entry to keep them apart.

A transform receives the row before the `fields` are read and returns a row or an array of rows:

```ts
// one CSV line per order line
transforms: [(order: { id: number; lines: { sku: string; qty: number }[] }) =>
  order.lines.map((line) => ({ id: order.id, sku: line.sku, qty: line.qty }))],
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Csv.Options` | `@Config('templates.csv')` getter on `Csv`, read per render | json2csv defaults | none | Set `templates.csv`; or subclass `Csv` and redeclare `Options` with another `@Config` path or `defaultValue` ([example](03-csv-renderer-service.md#add-a-tsv-renderer)) |
| Cell formatting | `templates.csv.formatters` | json2csv formatters | your functions | One function per value type |
| Row shaping | `templates.csv.transforms` | none | your functions | Functions run in array order |

## Important behaviour

- The options apply to **every** `.csv` render in the app. For a second format, register a second renderer instead of switching config; see [Extending and replacing the CSV renderer](03-csv-renderer-service.md).
- There is no per-call option: `IJsonToCsvOptions` carries only `fields` and `data`.
- `templates.csv.fields` wins over the model's `fields`, because config is spread after it.
- A changed `templates.csv` value takes effect on the next render; no restart is needed.
- `eol` defaults to the host's line ending, so the same code gives different bytes on Windows and Linux.
- `defaultValue` replaces `undefined` and missing values; a `null` value goes to the `object` formatter and becomes an empty cell.

## Best practices

- Pin `eol` (`\r\n` per RFC 4180, or `\n`) for files sent to other systems.
- Turn on `withBOM` for files opened in Excel that contain non-ASCII text.
- Use `delimiter: ';'` together with a decimal-comma `number` formatter for spreadsheets in locales with a decimal comma.
- Keep `transforms` cheap: they run once per row on the event loop.

## Patterns and antipatterns

```ts
// Don't: fields in config replace the columns every caller passes
templates: { csv: { fields: ['id', 'total'] } }

// Do: keep columns in the model, format in config
templates: { csv: { delimiter: ';', withBOM: true } }
```

## Examples

### Excel-friendly exports for a decimal-comma locale

```ts sample
import '@spinajs/templates-csv';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';

async function priceListForExcel(): Promise<string> {
  const config = await DI.resolve(Configuration);

  // Usually set in a config file; set here to show the effect on the next render.
  config.set('templates.csv', {
    delimiter: ';',
    eol: '\r\n',
    withBOM: true,
    formatters: {
      number: (value: number) => value.toFixed(2).replace('.', ','),
    },
  });

  const templates = await DI.resolve(Templates);
  return templates.render('price-list.csv', {
    fields: ['sku', 'name', 'price'],
    data: [{ sku: 'A-1', name: 'Kabel USB-C', price: 19.9 }],
  });
}

void priceListForExcel().then((csv) => console.log(csv));
// <BOM>"sku";"name";"price"
// "A-1";"Kabel USB-C";19,90
```

## Related

- [Rendering CSV](01-rendering-csv.md): where the options are applied in the render flow.
- [Extending and replacing the CSV renderer](03-csv-renderer-service.md): a renderer with its own options section.
- [`@spinajs/configuration`](../configuration/README.md): config files, sources and `Configuration.set()`.
