# Custom value converter

`DbConfigValueConverter` turns `Value` text into typed values and back for every part of the package. Register a subclass in its place to change a stored format or a read type once, for the source, the bootstrapper, the watch poll and the `DbConfig` model together.

## How it works

1. `DbConfigValueConverter` is a `@Singleton` class. It is not registered under another token; callers resolve it by class.
2. `ConfiguratioDbSource` and `DbConfigSourceBotstrapper` get it with `@Autoinject(DbConfigValueConverter)`, when they are first resolved.
3. The ORM resolves it for every `@DbConfigValue` column with `connection.Container.resolve(DbConfigValueConverter)`, when `Orm` sets up model descriptors.
4. `DI.register(MyConverter).as(DbConfigValueConverter)` makes each of those resolves return `MyConverter`: DI resolves the last class registered under a key.
5. The registration must run before the first of these resolves: before `Configuration` resolves (source), before bootstrappers run (bootstrapper), before `Orm` resolves (model).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Value converter | class `DbConfigValueConverter`, `@Singleton`, resolved by class | `DbConfigValueConverter extends UniversalValueConverter` (`@spinajs/orm`) | none shipped | `DI.register(MyConverter).as(DbConfigValueConverter)` at module load, before the app starts. |

Methods meant for overriding:

| Method | Called by | Contract |
| --- | --- | --- |
| `toDB(value, model, column, options)` | bootstrapper (each `defaultValue`), `DbConfig` model writes, static `DbConfig.insert()` | Return the text to store, or `null`/`undefined` unchanged. Read the type from `model[options.TypeColumn]`; `model` is `undefined` for static inserts. |
| `fromDB(value, raw, options)` | source (raw rows), `DbConfig` model reads, watch poll | Return the typed value. Read the type from `raw[options.TypeColumn]`. Return `null`, `undefined` and `''` unchanged. |

Call `super.toDB()` / `super.fromDB()` for every type you do not change. The base class handles the config-only types (`oneOf`, `manyOf`, `file`, `range`, `*-range`) and passes the rest to `UniversalValueConverter`.

### Value converter: custom implementation

The default `fromDB()` reads `datetime` values in the server's local zone. A scheduler that compares them with UTC timestamps needs them in UTC. This converter changes the read side only; stored text stays ISO 8601 with offset.

```ts sample
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { IUniversalConverterOptions } from '@spinajs/orm';
import { DbConfigValueConverter } from '@spinajs/configuration-db-source';

export class UtcDbConfigValueConverter extends DbConfigValueConverter {
  public fromDB(value: any, raw: any, options: IUniversalConverterOptions): any {
    const parsed = super.fromDB(value, raw, options);

    if (DateTime.isDateTime(parsed)) {
      return parsed.toUTC();
    }
    if (Array.isArray(parsed) && parsed.every((x) => DateTime.isDateTime(x))) {
      return parsed.map((x: DateTime) => x.toUTC());
    }
    return parsed;
  }
}

// at module load, before Configuration, bootstrappers and Orm are resolved
DI.register(UtcDbConfigValueConverter).as(DbConfigValueConverter);

export class MaintenanceWindow {
  @Config('maintenance.window', {
    expose: true,
    exposeOptions: { type: 'datetime-range', group: 'maintenance', label: 'Next maintenance window', watch: true },
  })
  protected Window: DateTime[] | null;

  public isActive(now = DateTime.utc()): boolean {
    if (!this.Window || this.Window.length !== 2) {
      return false;
    }
    const [start, end] = this.Window;
    return now >= start && now <= end;
  }
}
```

## Important behaviour

- **Register early or not at all.** A source, bootstrapper or connection that already resolved the converter keeps the old instance for the life of the process.
- **One converter for all.** The replacement applies to every `@DbConfigValue` column, including those on your own models.
- **The type set is closed.** `ConfigurationEntryType` and the migration's `Type` enum list 15 types. A new type name needs your own migration widening the enum, and `exposeOptions.type` will not type-check it.
- **`toDB()` runs on loose input.** `@spinajs/configuration-http` hands over raw request values (ISO strings, numeric strings, `'1'`/`'0'`). An override must accept them as the base class does.
- **Stored text is shared state.** Changing the format `toDB()` writes makes existing rows unreadable unless `fromDB()` still understands the old form.

## Best practices

- Change the read side (`fromDB()`) when you only need another runtime type; the stored text stays portable.
- Keep `toDB()` and `fromDB()` symmetric: `fromDB(toDB(x))` must give back an equal value under `isConfigValueEqual()`, or the watch poll sees a change on every tick.
- Put the registration in the module that declares the converter, and import that module first.

## Patterns and antipatterns

```ts
// Don't: register after startup; the source and the ORM keep the old converter
await DI.resolve(Orm);
DI.register(UtcDbConfigValueConverter).as(DbConfigValueConverter);

// Do: register at module load, before anything resolves Configuration or Orm
DI.register(UtcDbConfigValueConverter).as(DbConfigValueConverter);
```

## Examples

### Accept comma-separated lists for `manyOf`

Operators editing rows by hand write `pl,en` instead of `["pl","en"]`. This converter reads both forms and always writes JSON.

```ts sample
import { DI } from '@spinajs/di';
import { IUniversalConverterOptions } from '@spinajs/orm';
import { DbConfigValueConverter } from '@spinajs/configuration-db-source';

export class LenientDbConfigValueConverter extends DbConfigValueConverter {
  public fromDB(value: any, raw: any, options: IUniversalConverterOptions): any {
    if (raw[options.TypeColumn] === 'manyOf' && typeof value === 'string' && !value.trim().startsWith('[')) {
      return value
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
    }
    return super.fromDB(value, raw, options);
  }
}

DI.register(LenientDbConfigValueConverter).as(DbConfigValueConverter);
```

## Related

- [Entry types and the value converter](04-entry-types-and-converter.md): the default text form of every type.
- [Custom configuration source](07-custom-configuration-source.md): `this.Converter` in a source subclass.
- [ORM converters and hydration](../orm/04-converters-and-hydration.md): how column converters are resolved and called.
