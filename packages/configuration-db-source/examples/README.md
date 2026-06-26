# `@spinajs/configuration-db-source` examples

Each file is self-contained and imports from `@spinajs/configuration-db-source`
exactly as application code would. Importing the package is enough to register
its bootstrapper, configuration source, model and migration.

| File | Shows |
| --- | --- |
| [01-getting-started.ts](01-getting-started.ts) | wiring it up: db connection, running the migration, loading config rows |
| [02-expose-config.ts](02-expose-config.ts) | exposing a `@Config` value to the db (`expose` / `exposeOptions`) |
| [03-watch-config.ts](03-watch-config.ts) | live-reloading watched values and overriding the poll interval |
| [04-entry-types.ts](04-entry-types.ts) | the entry `Type`s, their stored text format and parsed values |
| [05-custom-connection.ts](05-custom-connection.ts) | reading config from a custom connection / table (with a custom migration) |

## How it fits together

1. **Provide a db connection.** The source loads last (Order `999`) and reads
   `db.Connections` that an earlier source (eg. a config file) already produced.
2. **Create the table.** Run the bundled migration (it creates `configuration`
   on the default connection) — eg. via `Migration.OnStartup` on the connection.
3. **Load.** On `Configuration.load()` the source reads every row whose `Exposed`
   flag is set and merges it into the config under its `Slug`.
4. **(Optional) Expose & watch.** `@Config` properties marked `expose: true` are
   inserted into the table on first run; those also marked `watch: true` are
   periodically refreshed into the live configuration.

## Gated on ORM resolution

The db-writing parts (persisting exposed options + the watch timer) are
**deferred until the ORM module is resolved**. The bootstrapper hooks DI's
resolve event with `DI.once('di.resolved.Orm', …)` — `@spinajs/di` emits a
`di.resolved.<Type>` event the first time a type is resolved/cached — and only
then inserts the exposed options and starts the watch timer. The live
`di.registered.__configuration_property__` handler is likewise guarded by
`DI.has(Orm)`.

So the ORM must actually be resolved somewhere (injected, or
`await DI.resolve(Orm)`) for `expose` / `watch` to do anything — see
[01-getting-started.ts](01-getting-started.ts), which resolves the ORM before
loading the configuration.

## Key concepts

- **`Slug` is the config path.** A row's `Slug` is exactly the path you read with
  `Configuration.get(...)` / pass to `@Config(...)`. `Group` is display-only
  metadata (for an admin UI) and is **not** part of the path.
- **`Type` drives parsing.** Values are stored as text; the `Type` column decides
  how each is parsed back into a JS value on load (see
  [04-entry-types.ts](04-entry-types.ts)).
- **`Exposed` gates loading.** Only rows with `Exposed` set are loaded, so you can
  keep a row in the table without publishing it to the running app.

## Running an example

The examples are TypeScript and use SQLite. After building the workspace:

```bash
node lib/mjs/examples/01-getting-started.js
```

Or run directly with `ts-node` / `ts-mocha` from the package root. They expect
`@spinajs/orm-sqlite` to be installed (it already is, as a dev dependency).
