# `@spinajs/configuration-db-source`

A SpinaJS configuration source that loads application configuration from a
database table and lets `@Config`-decorated values be **exposed** to the
database so they can be administered at runtime — optionally **watched** for
live updates without a restart.

## Documentation

Full documentation lives in [docs/configuration-db-source](../../docs/configuration-db-source/README.md):

- [Database configuration source](../../docs/configuration-db-source/01-database-source.md)
- [Exposing options](../../docs/configuration-db-source/02-exposing-options.md)
- [Watching options](../../docs/configuration-db-source/03-watching-options.md)
- [Entry types and the value converter](../../docs/configuration-db-source/04-entry-types-and-converter.md)
- [File entries and validators](../../docs/configuration-db-source/05-file-entries-and-validators.md)
- [Running under authz](../../docs/configuration-db-source/06-running-under-authz.md)
- [Custom configuration source](../../docs/configuration-db-source/07-custom-configuration-source.md)
- [Custom value converter](../../docs/configuration-db-source/08-custom-value-converter.md)
- [Customizing the bootstrapper](../../docs/configuration-db-source/09-customizing-the-bootstrapper.md)

## Installation

```bash
npm install @spinajs/configuration-db-source
```

Importing the package is enough to register everything it provides:

- a **Bootstrapper** that persists exposed options and runs the watch timer,
- a **ConfigurationSource** (load order `999`, so it runs after file sources)
  that reads the configuration table and merges every exposed row into the
  config,
- the **`DbConfig`** model and the **migration** that creates the table.

```ts
import '@spinajs/configuration-db-source';
```

## Examples

Runnable, self-contained examples live in [examples/](examples/) — see
[examples/README.md](examples/README.md) for the index:

- [getting started](examples/01-getting-started.ts) — connection, migration, loading rows
- [exposing config to the db](examples/02-expose-config.ts) — `expose` / `exposeOptions`
- [watching for live updates](examples/03-watch-config.ts) — `watch` + poll interval
- [entry types](examples/04-entry-types.ts) — stored text formats and parsed values
- [custom connection / table](examples/05-custom-connection.ts) — with a custom migration

## How it works

1. **Provide a db connection.** The source loads last and reads the
   `db.Connections` that an earlier source (a config file, usually) produced.
2. **Create the table.** Run the bundled migration — it creates the
   `configuration` table on the default connection (eg. set
   `Migration: { OnStartup: true }` on the connection).
3. **Load.** On `Configuration.load()` the source reads every row whose
   `Exposed` flag is set and merges it into the config under its `Slug`.
4. **Expose & watch (optional).** `@Config` properties marked `expose: true` are
   inserted (InsertOrIgnore) on first run; those also marked `watch: true` are
   periodically refreshed into the live configuration.

```ts
import { Config } from '@spinajs/configuration';

export class MailService {
  @Config('mailer.fromAddress', {
    defaultValue: 'no-reply@example.com',
    expose: true,
    exposeOptions: { type: 'string', group: 'mailer', label: 'From address', watch: true },
  })
  protected FromAddress: string;
}
```

## When it runs — gated on the configuration table

This package writes to the database **only once the `configuration` table is ready**.
The bootstrapper does no db work when it runs; it hooks DI's resolve events and
defers everything until then:

- `di.resolved.Orm`, when the table exists: the `Orm` resolves after its
  `Migration.OnStartup` migrations, which include the bundled one, and a
  database migrated by `migrate-up` has it already.

The first such event **(1)** inserts every exposed `@Config` option into the
table (InsertOrIgnore) and **(2)** starts the watch timer. `@Config` properties
registered after that are persisted/loaded live by a
`di.registered.__configuration_property__` handler; before it, the sweep handles them.

**Implication:** resolve the `Orm`
somewhere in your app for exposed options to be written and watched. Reading existing
rows is independent of this — it happens during `Configuration.load()` via the
source, which uses the resolved ORM connection when one is available.

## Configuration

Set under the `configuration_db_source` key (an earlier source must provide it):

| Key | Default | Description |
| --- | --- | --- |
| `connection` | `default` | name of the `db.Connections` entry to read from (`default` resolves to `db.DefaultConnection`) |
| `table` | `configuration` | table to read configuration rows from |

The watch poll interval defaults to **3 minutes**. Override it by registering the
`__config_watch_interval__` DI value (milliseconds) before the ORM resolves:

```ts
DI.register({ value: 30_000 }).asValue('__config_watch_interval__');
```

> The `connection` / `table` options affect the **load** path only. Exposing and
> watching use the `DbConfig` model, which is bound to the `configuration` table
> on the `default` connection — see
> [05-custom-connection.ts](examples/05-custom-connection.ts).

## Entry types

Each row stores its `Value` as text plus a `Type` that decides how it is
converted. Values are stored in **canonical form** (ISO dates/times, decimal
numbers, `true`/`false` booleans) — there is no legacy-format tolerance.

| `Type` | Stored text | Runtime value |
| --- | --- | --- |
| `string`, `file`, `oneOf` | as-is | `string` |
| `number` | integer text | `number` |
| `float`, `range` | decimal text | `number` |
| `boolean` | `true` / `false` | `boolean` |
| `json` | JSON | parsed object/array |
| `manyOf` | JSON array | `string[]` |
| `date` | ISO date (`yyyy-MM-dd`) | luxon `DateTime` |
| `time` | ISO time (`HH:mm:ss`) | luxon `DateTime` |
| `datetime` | ISO 8601 | luxon `DateTime` |
| `date-range` / `time-range` / `datetime-range` | two ISO values joined by `;` | `DateTime[]` |

Conversion is handled by `DbConfigValueConverter`, a subclass of the ORM's
`UniversalValueConverter` (the universal primitives live in the shared converter;
the config-only composite types — `oneOf`, `manyOf`, `file`, `range` and the
`*-range` types — live in the subclass). See
[04-entry-types.ts](examples/04-entry-types.ts) for a worked example.

## File entries

An entry of `type: 'file'` stores a file name in `Value`. `meta.file` says where the
file lives and what may be uploaded through `@spinajs/configuration-http`:

```ts
import { FileTypeEnum } from '@spinajs/http';

@Config('yourscreen.kalkulator.template', {
  defaultValue: 'kalkulator.xlsx',
  expose: true,
  exposeOptions: {
    type: 'file',
    group: 'templates',
    label: 'Offer calculator template',
    meta: {
      file: {
        fs: 'fs-excel-templates', // @spinajs/fs provider name, required
        extensions: ['xlsx'], // lowercase, without the dot
        mimeTypes: [FileTypeEnum.xlsx], // checked against the type detected from content
        maxSize: 10 * 1024 * 1024, // bytes, default CONFIG_FILE_DEFAULT_MAX_SIZE ( 10 MB )
        validator: OfferTemplateValidator, // optional, class or name
      },
    },
  },
})
protected Template: string;
```

- A `type: 'file'` entry without `meta.file.fs` throws when it is registered, with the slug in the message.
- `validator` is stored as a name ( the class name for a class ). A validator extends
  `ConfigFileValidator`, is registered with `@Injectable(ConfigFileValidator)` and rejects a
  file by throwing `ValidationFailed`; its message is returned to the client. It is looked up
  by instance `ServiceName` or class name ( `resolveConfigFileValidator` ).
- A class `validator` must be declared before the class holding the decorated property in module
  load order - otherwise the decorator reads it in its temporal dead zone ( ESM ) and throws.
  Use the string form ( `validator: 'OfferTemplateValidator'` ) when that order cannot be guaranteed.

```ts
@Injectable(ConfigFileValidator)
export class OfferTemplateValidator extends ConfigFileValidator {
  public async validate(file: IConfigFileCandidate, entry: DbConfig): Promise<void> {
    // file.localPath, file.originalName, file.size, file.mimeType
    throw new ValidationFailed('Template is missing the Offer sheet', []);
  }
}
```

## Key concepts

- **`Slug` is the config path** — exactly what you read with
  `Configuration.get(...)` / pass to `@Config(...)`. `Group` is display-only
  metadata and is not part of the path.
- **`Exposed` gates loading** — only exposed rows reach the running app.

## Under authz

An app that guards `DbConfig` (for example through `@spinajs/configuration-http`) calls
`requireSystemPrincipal()`. From then on, persistence of exposed options and the watch poll run as `SYSTEM`
(`runAs(SYSTEM, 'config-poll')`). They start once the root authz service boots (the http server does it). An app without an http server
waits 15 s, logs a warning and boots the service itself; an http app slower than that would lose the
boot-time check of `@Access` permissions of controllers registered later.
Without that call, queries run as before.
