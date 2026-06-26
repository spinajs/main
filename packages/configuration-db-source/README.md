# `@spinajs/configuration-db-source`

A SpinaJS configuration source that loads application configuration from a
database table and lets `@Config`-decorated values be **exposed** to the
database so they can be administered at runtime — optionally **watched** for
live updates without a restart.

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

## When it runs — gated on ORM resolution

This package writes to the database **only after the ORM module is resolved**.
The bootstrapper does no db work when it runs; instead it hooks DI's resolve
event and defers everything until the ORM is available:

- It subscribes with `DI.once('di.resolved.Orm', …)`. `@spinajs/di` emits a
  `di.resolved.<Type>` event the first time a type is resolved/cached (see the
  container cache in `@spinajs/di`), so this handler fires the first time `Orm`
  is resolved. At that point the package **(1)** inserts every exposed `@Config`
  option into the table (InsertOrIgnore) and **(2)** starts the watch timer.
- `@Config` properties registered *after* the ORM is up are persisted/loaded
  live by a `di.registered.__configuration_property__` handler — but it is
  guarded by `DI.has(Orm)`, so before the ORM exists it does nothing (those vars
  are handled by the `di.resolved.Orm` step above).

**Implication:** the ORM must actually be resolved somewhere in your app
(injected, or `await DI.resolve(Orm)`) for exposed options to be written and
watched. If nothing resolves the ORM, those hooks never fire. Reading existing
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

## Key concepts

- **`Slug` is the config path** — exactly what you read with
  `Configuration.get(...)` / pass to `@Config(...)`. `Group` is display-only
  metadata and is not part of the path.
- **`Exposed` gates loading** — only exposed rows reach the running app.
