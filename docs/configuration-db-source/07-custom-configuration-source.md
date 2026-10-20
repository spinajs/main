# Custom configuration source

`ConfiguratioDbSource` is one entry in the list of `ConfigurationSource`s. Subclass it to change how rows are selected, how the connection is found or when it loads; drop the default with `DI.unregister()` so the two do not both run.

## How it works

1. Importing the package runs `@Singleton()` and `@Injectable(ConfigurationSource)` on `ConfiguratioDbSource`: it is registered under `ConfigurationSource` and under itself.
2. `FrameworkConfiguration` resolves `Array.ofType(ConfigurationSource)`: **every** registered class, sorted by `Order`, each `Load()` result merged in turn.
3. A subclass registered with `@Injectable(ConfigurationSource)` joins that list. It does not replace the base class.
4. `DI.unregister(ConfiguratioDbSource)` removes the base class from every key it is registered under, so only your subclass runs.
5. Both steps must happen before `Configuration` is resolved; the list is built once, on the first resolve.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Database source | `ConfigurationSource` list, `Array.ofType`; `@Singleton` | `ConfiguratioDbSource` | `JsFileSource`, `JsonFileSource`, `StaticConfigurationSource(...)` share the list | Subclass + `@Injectable(ConfigurationSource)` + `DI.unregister(ConfiguratioDbSource)`. |

Members meant for subclasses:

| Member | Kind | Default behaviour | Override to |
| --- | --- | --- | --- |
| `Order` | getter | `999` | Load at another point. Keep it above the source that provides `db.Connections`. |
| `Load(configuration)` | method | full flow of [Database configuration source](01-database-source.md) | Select other rows, add filters, map paths. |
| `Connect()` | protected method | finds the connection in `db.Connections`, reuses the ORM's or opens a driver connection; sets `this.Connection` | Use another connection lookup, or close what you open. |
| `CheckTable()` | protected method | `this.Connection.schema().tableExists(this.Options.table)` | Check a view, a schema-qualified name, or skip the check. |
| `Connection` | protected `OrmDriver` | set by `Connect()` | Read for your own queries. |
| `Options` | protected `IConfiguratioDbSourceConfig` | `{ connection, table }` | Read or extend with keys of your own. |
| `Configuration` | protected `Configuration` | the configuration being loaded | Read keys loaded by earlier sources. |
| `Converter` | protected `DbConfigValueConverter`, `@Autoinject` | the DI singleton | Convert `Value` text the same way the default source does. |

### Database source: custom implementation

The `Environment` column exists in the table but the default source ignores it. This subclass loads rows whose `Environment` is empty or equal to `APP_ENV`, so one database can hold settings for `staging` and `production`. It reuses `Connect()`, `CheckTable()` and the converter.

```ts sample
import _ from 'lodash';
import { DI, Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration';
import { ConfiguratioDbSource, IConfigurationEntry } from '@spinajs/configuration-db-source';

interface IEnvironmentEntry extends IConfigurationEntry {
  Exposed: unknown;
  Environment: string | null;
}

@Injectable(ConfigurationSource)
export class EnvironmentDbSource extends ConfiguratioDbSource {
  public async Load(configuration: Configuration): Promise<IConfigLike> {
    this.Configuration = configuration;
    this.Options = configuration.get('configuration_db_source', { connection: 'default', table: 'configuration' });

    await this.Connect();
    if (!this.Connection || !(await this.CheckTable())) {
      return {} as IConfigLike;
    }

    const env = configuration.get<string>('process.env.APP_ENV');
    const rows = await this.Connection.select<IEnvironmentEntry[]>().from(this.Options.table);

    const result = {} as IConfigLike;
    rows
      .filter((row) => Boolean(row.Exposed))
      .filter((row) => !row.Environment || row.Environment === env)
      // rows bound to an environment override the shared ones
      .sort((a, b) => Number(Boolean(a.Environment)) - Number(Boolean(b.Environment)))
      .forEach((row) => {
        _.set(result, row.Slug, this.Converter.fromDB(row.Value, row, { TypeColumn: 'Type' }));
      });

    return result;
  }
}

DI.unregister(ConfiguratioDbSource);
```

Two rows cannot share a `Slug` because of the unique index `configuration_unique_slug`. To keep a shared and a per-environment row of the same setting, drop that index in your own migration, or use a slug convention such as `mailer.from@production` and strip the suffix in `Load()`.

## Important behaviour

- **Registration adds, it does not replace.** Without `DI.unregister(ConfiguratioDbSource)`, both sources run and the later `Order` wins key by key.
- **Unregister before the first `Configuration` resolve.** The source list is resolved once; later changes are ignored until the configuration is rebuilt.
- **`Load()` must not throw** if the app should start without the database. The default source catches every error and returns `{}`; a subclass that throws stops `Configuration` from resolving.
- **`Order` below the file sources breaks `Connect()`.** The source reads `db.Connections` from sources that already ran; with `Order` below `1` it sees nothing unless a `StaticConfigurationSource` with a lower `Order` provides it.
- **Exposing and watching are separate.** They use `DbConfig` on the `default` connection, not your source. A custom source changes what is loaded, not what is written.

## Best practices

- Override the smallest member that does the job: `CheckTable()` or `Connect()` before `Load()`.
- Reuse `this.Converter` so typed values match what `DbConfig` and the watch poll produce.
- Call `DI.unregister(ConfiguratioDbSource)` in the same module that declares your subclass, so the two can never be loaded apart.

## Patterns and antipatterns

```ts
// Don't: a second source with the same table reads every row twice
@Injectable(ConfigurationSource)
export class EnvironmentDbSource extends ConfiguratioDbSource { /* ... */ }

// Do: unregister the default in the same module
@Injectable(ConfigurationSource)
export class EnvironmentDbSource extends ConfiguratioDbSource { /* ... */ }
DI.unregister(ConfiguratioDbSource);
```

## Examples

### Read configuration from a database view

A DBA exposes settings through a view `v_app_settings`. On SQLite, `tableExists()` only matches `type='table'` in `sqlite_master`, so the default `CheckTable()` reports the view as missing. The subclass checks with a query instead.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { ConfigurationSource } from '@spinajs/configuration';
import { ConfiguratioDbSource } from '@spinajs/configuration-db-source';

@Injectable(ConfigurationSource)
export class ViewDbSource extends ConfiguratioDbSource {
  protected async CheckTable(): Promise<boolean> {
    try {
      await this.Connection.select().from(this.Options.table).take(1);
      return true;
    } catch {
      return false;
    }
  }
}

DI.unregister(ConfiguratioDbSource);
```

Set `configuration_db_source.table` to `'v_app_settings'`; the view must return `Slug`, `Value`, `Type` and `Exposed`.

## Related

- [Database configuration source](01-database-source.md): the default `Load()` flow.
- [Custom value converter](08-custom-value-converter.md): `this.Converter` follows a DI replacement.
- [Custom configuration sources](../configuration/04-custom-configuration-sources.md): `ConfigurationSource`, `Order` and `StaticConfigurationSource`.
