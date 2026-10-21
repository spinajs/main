# Entry types and the value converter

Every row stores `Value` and `Default` as text. The row's `Type` column decides how that text becomes a typed value and back. `DbConfigValueConverter` does the conversion for the source, the bootstrapper and the `DbConfig` model alike.

## How it works

1. **Write.** `DbConfigValueConverter.toDB(value, model, column, { TypeColumn })` reads the type from `model[TypeColumn]`. Without a model (a static `DbConfig.insert({...})` with a plain object) it infers the type from the value: a `DateTime` is `datetime`, an array of `DateTime` is `datetime-range`, any other object or array is `json`, the rest uses `typeof value`.
2. It returns the canonical text for that type, or `null`/`undefined` unchanged. Types it does not handle go to `UniversalValueConverter.toDB()` from `@spinajs/orm`.
3. **Read.** `fromDB(value, rawRow, { TypeColumn })` reads the type from `rawRow[TypeColumn]` and parses the text. `null`, `undefined` and `''` come back unchanged.
4. The source calls `fromDB()` on raw rows; the `DbConfig` model calls both through its `@DbConfigValue('Type')` columns; the bootstrapper calls `toDB()` on each `defaultValue`.

## Entry types

`ConfigurationEntryType` lists 15 types. The migration's `Type` enum allows the same 15.

| `Type` | Stored text | Read as | `toDB` accepts |
| --- | --- | --- | --- |
| `string` | as-is | `string` | any value, unchanged |
| `oneOf` | as-is | `string` | a string; allowed values live in `meta.oneOf` |
| `file` | as-is (file name) | `string` | a string; see [File entries](05-file-entries-and-validators.md) |
| `number` | `parseInt` text, e.g. `'42'` | `number` (integer) | a number or numeric string |
| `float` | decimal text, e.g. `'10.4'` | `number` | a number or numeric string |
| `range` | `Number(value)` text | `number` | a number or numeric string; bounds in `meta.min`, `meta.max` |
| `boolean` | `'true'` / `'false'` | `boolean` | `true`/`false`, `'true'`/`'1'` (true), anything else false |
| `json` | JSON | object or array | any JSON-serializable value |
| `manyOf` | JSON array | `string[]` | an array; allowed values live in `meta.manyOf` |
| `date` | ISO date, `yyyy-MM-dd` | luxon `DateTime` | a `DateTime` or ISO string |
| `time` | ISO time without offset, `HH:mm:ss.SSS` | luxon `DateTime` | a `DateTime` or ISO string |
| `datetime` | ISO 8601 with offset | luxon `DateTime` | a `DateTime` or ISO string |
| `date-range` | ISO dates joined by `;` | `DateTime[]` | an array of `DateTime` or ISO strings |
| `time-range` | ISO times joined by `;` | `DateTime[]` | an array of `DateTime` or ISO strings |
| `datetime-range` | ISO datetimes joined by `;` | `DateTime[]` | an array of `DateTime` or ISO strings |

`isConfigValueEqual(a, b)` compares two read values: `DateTime` by instant (`toMillis()`), arrays and objects element by element, the rest with lodash `isEqual`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@DbConfigValue(typeColumn = 'Type')` | model property | `typeColumn`: name of the sibling column holding the entry type | Sets `DbConfigValueConverter` as the column converter, with `{ TypeColumn: typeColumn }`. Works on any `ModelBase`, not only `DbConfig`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Value converter | class `DbConfigValueConverter`, `@Singleton`; registered under itself at import, not under another token, resolved by class | `DbConfigValueConverter extends UniversalValueConverter` | none shipped | `DI.register(MyConverter).as(DbConfigValueConverter)` before bootstrappers and `Orm` resolve. Override `toDB()` and `fromDB()`, call `super` for the rest. See [Custom value converter](08-custom-value-converter.md). |
| Column binding | `@DbConfigValue(typeColumn)` decorator, stored in the model descriptor's `Converters` | `DbConfig.Value`, `DbConfig.Default` | your own models | Put it on your own "type column" model, see the example below. The ORM resolves the converter class through the connection's container, so a DI replacement applies here too. |

## Important behaviour

- **Canonical form only.** There is no legacy-format tolerance: a `boolean` row holding `'1'` reads as `false`, a `date` row holding `24.06.2026` reads as an invalid `DateTime`.
- **`number` truncates.** `fromDB` uses `parseInt`, so `'10.5'` in a `number` row reads as `10`. Use `float` or `range` for decimals.
- **Static inserts guess the type.** `DbConfig.insert({ ... })` with a plain object calls `toDB()` without a model, so the type comes from the value. Strings pass unchanged, numbers become text, booleans become `'true'`/`'false'`, objects and arrays become JSON (which `json` and `manyOf` rows read back), `DateTime` values become ISO datetimes and arrays of them ISO datetimes joined by `;`.
- **Static updates skip the converter.** `DbConfig.update({ Value: ... })` binds the value as-is; column converters do not run. Write the canonical text yourself.
- **Ranges split on `;`.** A value containing `;` cannot be stored in a `*-range` type.
- **`time` reads as today.** `DateTime.fromISO('13:05:09')` gives today's date at that time in the local zone.
- **One conversion point.** `toDB()` accepts loose input (ISO strings, numeric strings, `'1'`/`'0'`), so callers such as `@spinajs/configuration-http` validate and hand over the raw request value.

## Best practices

- Write rows through a `DbConfig` instance (`row.Value = x; await row.update()`): the model knows the `Type`, so `toDB()` converts correctly.
- In static updates write the canonical text yourself: `'true'`, `'42'`, `'2026-06-24'`, `JSON.stringify([...])`.
- Use `DateTime` values in code for every date type and let the converter produce the text.

## Patterns and antipatterns

```ts
// Don't: a static update skips the column converter, so the array is bound unconverted
await DbConfig.update({ Value: ['pl', 'en'] }).where('Slug', 'i18n.languages');

// Do: load the row, so the converter sees Type = 'manyOf'
const row = await DbConfig.where('Slug', 'i18n.languages').first();
row.Value = ['pl', 'en'];
await row.update();
```

## Examples

### Read stored text the way the source does

```ts sample
import { DateTime } from 'luxon';
import { DbConfigValueConverter } from '@spinajs/configuration-db-source';

const converter = new DbConfigValueConverter();
const read = (value: string, type: string): unknown => converter.fromDB(value, { Type: type }, { TypeColumn: 'Type' });

export const examples = {
  retries: read('3', 'number'),
  vatRate: read('0.23', 'float'),
  enabled: read('true', 'boolean'),
  languages: read('["pl","en"]', 'manyOf'),
  holidays: read('2026-12-24;2026-12-26', 'date-range') as DateTime[],
};
```

### Store typed per-tenant settings in your own table

`@DbConfigValue` works on any model with a type column. Here `tenant_settings` keeps the type in `Kind`.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { ConfigurationEntryType, DbConfigValue } from '@spinajs/configuration-db-source';

@Connection('default')
@Model('tenant_settings')
export class TenantSetting<T = unknown> extends ModelBase {
  @Primary()
  public Id: number;

  public TenantId: number;

  public Name: string;

  public Kind: ConfigurationEntryType;

  @DbConfigValue('Kind')
  public Value?: T;
}

export async function invoiceDueDays(tenantId: number): Promise<number> {
  const setting = (await TenantSetting.where({ TenantId: tenantId, Name: 'invoice.dueDays' }).first()) as TenantSetting<number> | undefined;
  return setting?.Value ?? 14;
}
```

## Related

- [Custom value converter](08-custom-value-converter.md): replace the converter for every caller.
- [ORM converters and hydration](../orm/04-converters-and-hydration.md): `UniversalValueConverter` and how column converters run.
- [Watching options](03-watching-options.md): uses `isConfigValueEqual()` to detect changes.
