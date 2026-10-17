# File validators

A file validator checks the content of an uploaded file before `ConfigFileUploads.accept` stores it: a required sheet in a spreadsheet, the header row of a CSV, the page size of a PDF. Write a class that extends `ConfigFileValidator`, register it, and name it in the entry's `meta.file.validator`.

`ConfigFileValidator` is declared in `@spinajs/configuration-db-source`; this package is the one that runs it.

## How it works

1. You declare the validator on the entry: `exposeOptions.meta.file.validator` takes the class or its name. `normalizeFileEntryOptions()` stores it as a name in `Meta`.
2. `ConfigFileUploads.accept()` first runs the built-in rules ([File uploads](05-file-uploads.md#acceptentry-file-validate-and-store)). Only a file that passes them reaches the validator.
3. `resolveConfigFileValidator(name)` goes through `DI.getRegisteredTypes(ConfigFileValidator)`, resolves each type, and returns the first whose instance `ServiceName`, or else class name, equals the stored name.
4. No match throws a plain `Error` (`configuration file validator '<name>' of '<slug>' is not registered`), answered as 500.
5. `validate(file, entry)` runs. It resolves to accept the file. A `ValidationFailed` it throws becomes `ConfigFileRejected` (400) with the same message; any other error propagates unchanged.
6. The temp file is removed after `accept` either way; the validator must not move or delete `file.localPath`.

### `IConfigFileCandidate`, the `file` argument

| Field | Type | Meaning |
| --- | --- | --- |
| `localPath` | `string` | Path of the multipart temp file; read it, do not remove it. |
| `originalName` | `string` | Name sent by the client. |
| `size` | `number` | Bytes. |
| `mimeType` | `string` | Content-detected type; `''` when detection failed. |

The `entry` argument is the `DbConfig` row: `Slug`, `Label`, `Meta` and the current `Value` are available.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `exposeOptions.meta.file.validator` | `string \| Class<ConfigFileValidator>` | none | class name, or `ServiceName` of a registered validator | The validator to run during `accept`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConfigFileValidator` | `ConfigFileValidator`; every `@Injectable(ConfigFileValidator)` class is listed. Lifetime of each class follows its own decorators: singleton by default, `@NewInstance()` for a fresh one per upload. Resolved by name on each upload. | none | Any number of your validators | Extend `ConfigFileValidator`, implement `validate()`, register with `@Injectable(ConfigFileValidator)`. |

### `ConfigFileValidator`: custom implementation

The only method is `validate(file, entry): Promise<void>`. Register the class before the first upload; importing its module at startup is enough. Reject with `ValidationFailed`: its message is shown to the admin.

```ts sample
import { readFile } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ConfigFileValidator, DbConfig } from '@spinajs/configuration-db-source';
import type { IConfigFileCandidate } from '@spinajs/configuration-db-source';
import { ValidationFailed } from '@spinajs/validation';

const PRICE_LIST_HEADER = 'sku;name;net_price;vat_rate';

/** Refuses a price list whose first line is not the expected header. */
@Injectable(ConfigFileValidator)
export class PriceListValidator extends ConfigFileValidator {
  public async validate(file: IConfigFileCandidate, entry: DbConfig): Promise<void> {
    const content = await readFile(file.localPath, 'utf8');
    const header = content.split(/\r?\n/, 1)[0]?.trim();
    if (header !== PRICE_LIST_HEADER) {
      throw new ValidationFailed(`${entry.Label ?? entry.Slug}: the first line must be "${PRICE_LIST_HEADER}"`, []);
    }
  }
}

// Declared after PriceListValidator, so the class reference is initialized when the decorator runs.
export class PricingSettings {
  @Config('pricing.priceList', {
    defaultValue: 'price-list.csv',
    expose: true,
    exposeOptions: {
      type: 'file',
      group: 'pricing',
      label: 'Price list',
      meta: { file: { fs: 'fs-pricing', extensions: ['csv'], maxSize: 2 * 1024 * 1024, validator: PriceListValidator } },
    },
  })
  protected PriceList!: string;
}
```

### One rule, several entries

Validators are looked up by name, so a parameterized rule becomes a small base class plus one registered subclass per variant. The base class is not registered. Each variant can also take its rule from `entry.Meta` or `entry.Slug` when one class serves several entries.

```ts sample
import { readFile } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import type { IMappableService } from '@spinajs/di';
import { ConfigFileValidator, DbConfig } from '@spinajs/configuration-db-source';
import type { IConfigFileCandidate } from '@spinajs/configuration-db-source';
import { ValidationFailed } from '@spinajs/validation';

/** Not registered: only its subclasses are validators. */
export abstract class CsvHeaderValidator extends ConfigFileValidator implements IMappableService {
  public abstract readonly ServiceName: string;
  protected abstract readonly Columns: string[];

  public async validate(file: IConfigFileCandidate, entry: DbConfig): Promise<void> {
    const header = (await readFile(file.localPath, 'utf8')).split(/\r?\n/, 1)[0] ?? '';
    const missing = this.Columns.filter((c) => !header.split(';').includes(c));
    if (missing.length > 0) {
      throw new ValidationFailed(`${entry.Slug}: missing columns ${missing.join(', ')}`, []);
    }
  }
}

@Injectable(ConfigFileValidator)
export class CustomerImportValidator extends CsvHeaderValidator {
  // a stable name: renaming the class does not break the stored Meta
  public readonly ServiceName = 'csv.customers';
  protected readonly Columns = ['tax_id', 'name', 'email'];
}

@Injectable(ConfigFileValidator)
export class StockImportValidator extends CsvHeaderValidator {
  public readonly ServiceName = 'csv.stock';
  protected readonly Columns = ['sku', 'warehouse', 'quantity'];
}

// Referenced by name, so declaration order does not matter:
// meta: { file: { fs: 'fs-imports', extensions: ['csv'], validator: 'csv.customers' } }
```

## Important behaviour

- The stored name is what counts: the instance `ServiceName` wins over the class name, as with `@AutoinjectService`. Renaming a class without a `ServiceName` breaks every entry that stored the old name.
- A class reference in `meta.file.validator` must be declared before the class holding the `@Config` property in module load order; otherwise the decorator reads it in its temporal dead zone (ESM) and throws. Use the string form when the order cannot be guaranteed.
- Resolving a name instantiates every registered validator type until one matches.
- Only `ValidationFailed` turns into a 400. Any other error, a parse failure of a third-party reader included, is a 500. Catch it and rethrow as `ValidationFailed` when a broken file is the user's mistake.
- The validator runs before the file is stored and before the slug schema check of the stored name.

## Best practices

- Give every validator a `ServiceName` and reference it by that string: the name in the database then survives refactors.
- Keep messages for the person uploading: name the file rule and what to fix.
- Leave size, extension and mime type to `meta.file`; the validator should only check what those cannot.

## Patterns and antipatterns

```ts
// Don't: a parser error escapes as a 500 for a file the user simply got wrong.
const rows = parseWorkbook(await readFile(file.localPath));

// Do: turn a broken file into a 400 with a message.
let rows;
try {
  rows = parseWorkbook(await readFile(file.localPath));
} catch {
  throw new ValidationFailed('The file is not a readable workbook', []);
}
```

## Examples

### Reject a template without the required placeholders

```ts sample
import { readFile } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import { ConfigFileValidator, DbConfig } from '@spinajs/configuration-db-source';
import type { IConfigFileCandidate } from '@spinajs/configuration-db-source';
import { ValidationFailed } from '@spinajs/validation';

/** HTML mail templates must contain every placeholder the mailer fills in. */
@Injectable(ConfigFileValidator)
export class MailTemplateValidator extends ConfigFileValidator {
  public readonly ServiceName = 'mail.template';

  public async validate(file: IConfigFileCandidate, entry: DbConfig): Promise<void> {
    const html = await readFile(file.localPath, 'utf8');
    const required = entry.Slug.endsWith('.passwordReset') ? ['{{name}}', '{{resetLink}}'] : ['{{name}}'];
    const missing = required.filter((p) => !html.includes(p));
    if (missing.length > 0) {
      throw new ValidationFailed(`The template is missing ${missing.join(', ')}`, []);
    }
  }
}
```

## Related

- [File uploads](05-file-uploads.md): where the validator runs in `accept`.
- [Customizing the upload service](07-upload-service-customization.md): checks that need more than one file, or run after storage.
- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): `ConfigFileValidator`, `meta.file`, `resolveConfigFileValidator`.
- [`@spinajs/validation`](../validation/README.md): `ValidationFailed`.
