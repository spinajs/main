# `@spinajs/configuration-http`

HTTP API over the database-stored configuration of [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): list entries, read one, update its value. It also ships `ConfigFileUploads`, the upload pipeline for `type: 'file'` entries, which a project composes into its own route.

It does **not** create or delete entries: code that exposes an option (`@Config(path, { expose: true })`) owns them. It has **no** file upload route: the project writes that route and owns the file history.

## Install

```sh
npm install @spinajs/configuration-http
```

The package config adds `ConfigurationController` to `system.dirs.controllers` and declares its permissions and roles. `ConfigurationHttpBootstrapper` registers `DbConfig` as the `configuration` access resource at boot.

## Features

| Feature | What it does |
| --- | --- |
| [Configuration API](01-configuration-api.md) | `GET /configuration`, `GET /configuration/:slug`, `PATCH /configuration/:slug` |
| [Value validation](02-value-validation.md) | Checks an incoming `Value` / `Default` against the entry `Type` and `Meta` |
| [Value schemas](03-value-schemas.md) | Adds a JSON schema per entry, registered under the entry slug |
| [Access control](04-access-control.md) | Permissions, the `admin.configuration` role, field filtering, row checks, the bootstrapper |
| [File uploads](05-file-uploads.md) | `ConfigFileUploads`: `accept`, `commit`, `discard` for `type: 'file'` entries |
| [File validators](06-file-validators.md) | `ConfigFileValidator`: your own content check, run during `accept` |
| [Customizing the upload service](07-upload-service-customization.md) | Subclass or replace `ConfigFileUploads`, swap mime detection and storage providers |

## Extension points at a glance

| Extension point | How you plug in | Page |
| --- | --- | --- |
| Value schema per slug | JSON / JS file in `system.dirs.schemas`, a `SchemaSource`, or `DataValidator.addSchema()` | [Value schemas](03-value-schemas.md) |
| Own routes over the validation helpers | Call `validateEntryValue()` / `valueSchema()` from your controller | [Value validation](02-value-validation.md#custom-routes-over-the-validation-helpers) |
| Roles and grants | `authz.rbac.roles` in your config: extend `admin.configuration` or grant one permission with a field set | [Access control](04-access-control.md) |
| `ConfigurationHttpBootstrapper` | `Bootstrapper` registered with `@Injectable(Bootstrapper)`; add your own bootstrapper next to it | [Access control](04-access-control.md#services-and-extension-points) |
| `ConfigFileValidator` | `@Injectable(ConfigFileValidator)` class, named in `meta.file.validator` | [File validators](06-file-validators.md) |
| `ConfigFileUploads` | `@Injectable(ConfigFileUploads)` subclass, or `DI.register(...).as(ConfigFileUploads)` | [Customizing the upload service](07-upload-service-customization.md) |
| `FileInfoService` (mime detection) | `DI.register(...).as(FileInfoService)` | [Customizing the upload service](07-upload-service-customization.md#fileinfoservice-custom-mime-detection) |
| Storage provider | `meta.file.fs` names an `@spinajs/fs` provider | [File uploads](05-file-uploads.md#configuration) |

## Quick start

```ts sample
import { Config } from '@spinajs/configuration';
import '@spinajs/configuration-db-source';
import '@spinajs/configuration-http';

export class MailerSettings {
  // The row `mailer.from` appears in GET /configuration and can be changed with PATCH /configuration/mailer.from.
  @Config('mailer.from', {
    defaultValue: 'noreply@example.com',
    expose: true,
    exposeOptions: { type: 'string', group: 'mailer', label: 'Sender address', watch: true },
  })
  protected From!: string;
}
```

```http
PATCH /configuration/mailer.from
Content-Type: application/json

{ "Value": "office@example.com" }
```

## Related packages

- [`@spinajs/configuration-db-source`](../configuration-db-source/README.md): owns the `configuration` table, `DbConfig`, entry types, `meta.file` and the watch poll.
- [`@spinajs/authz`](../authz/README.md): permissions, roles, field sets and `SYSTEM` used by every route.
- [`@spinajs/validation`](../validation/README.md): `DataValidator` and the schema sources behind value schemas.
- [`@spinajs/fs`](../fs/README.md): the storage providers and `FileInfoService` used by uploads.
- [`@spinajs/http`](../http/README.md): controllers, `@File()` and `IUploadedFile`.
