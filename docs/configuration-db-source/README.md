# `@spinajs/configuration-db-source`

A configuration source that reads application settings from a database table, and a bootstrapper that writes `@Config` options marked `expose: true` into that table so an admin can change them at runtime. Options marked `watch: true` are polled and pushed into the live configuration without a restart.

It does **not** ship an HTTP API or admin UI for the table: that is [`@spinajs/configuration-http`](../configuration-http/README.md). It does **not** create the table on a connection other than `default`.

## Install

```sh
npm install @spinajs/configuration-db-source
```

Importing the package registers everything: the source, the bootstrapper, the `DbConfig` model, the migration and the `configuration_db_source` config schema.

```ts
import '@spinajs/configuration-db-source';
```

## Features

| Feature | What it does |
| --- | --- |
| [Database configuration source](01-database-source.md) | `ConfiguratioDbSource` loads every exposed row of the `configuration` table into the config at its `Slug` path |
| [Exposing options](02-exposing-options.md) | `@Config(..., { expose: true })` inserts a row per option and keeps its metadata in sync |
| [Watching options](03-watching-options.md) | `watch: true` polls the row and updates the live configuration without a restart |
| [Entry types and the value converter](04-entry-types-and-converter.md) | The 15 entry types, their stored text form, `DbConfigValueConverter` and `@DbConfigValue` |
| [File entries and validators](05-file-entries-and-validators.md) | `type: 'file'` entries, `meta.file` options and custom `ConfigFileValidator` classes |
| [Running under authz](06-running-under-authz.md) | `requireSystemPrincipal()` makes the package's own queries run as `SYSTEM` |
| [Custom configuration source](07-custom-configuration-source.md) | Replace or subclass `ConfiguratioDbSource`, reusing `Connect()` and `CheckTable()` |
| [Custom value converter](08-custom-value-converter.md) | Replace `DbConfigValueConverter` through DI to change how values are stored and read |
| [Customizing the bootstrapper](09-customizing-the-bootstrapper.md) | Subclass `DbConfigSourceBotstrapper`, change its authz domain, trigger a poll on demand |

## Quick start

Expose a mail setting to the database and let an admin change it without a restart.

```ts sample
import { Config } from '@spinajs/configuration';
import '@spinajs/configuration-db-source';

export class MailService {
  @Config('mailer.fromAddress', {
    defaultValue: 'no-reply@example.com',
    expose: true,
    exposeOptions: { type: 'string', group: 'mailer', label: 'From address', watch: true },
  })
  protected FromAddress: string;

  public sender(): string {
    return this.FromAddress;
  }
}
```

For this to work:

1. A source that loads before this one (a config file) provides `db.Connections`.
2. The `default` connection has `Migration: { OnStartup: true }` and the app resolves the `Orm`, so the bundled migration creates the `configuration` table.
3. Something in the app resolves `Orm`. Exposed options are written and watched only after that.

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): the `Configuration` service, `@Config` and the source pipeline this package plugs into.
- [`@spinajs/configuration-http`](../configuration-http/README.md): REST endpoints and file uploads for the `configuration` table.
- [`@spinajs/orm`](../orm/README.md): connections, the `DbConfig` model, the migration and `UniversalValueConverter`.
- [`@spinajs/authz`](../authz/README.md): `SYSTEM` principal and `runAs()` used when the table is access-guarded.
