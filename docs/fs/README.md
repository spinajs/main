# `@spinajs/fs`

A file system abstraction: named file providers from configuration, one API for reading, writing, copying, zipping and hashing files, and a temp file system with automatic cleanup.

It ships a local disk provider (`fsNative`) and a temp wrapper (`fsTemp`) only. Remote storage comes from separate packages: `@spinajs/fs-s3`, `@spinajs/fs-ftp` and `@spinajs/fs-onedrive`. It does **not** serve files over HTTP.

## Install

```sh
npm install @spinajs/fs
```

## Features

| Feature | What it does |
| --- | --- |
| [Providers and configuration](01-providers-and-configuration.md) | Creates the configured providers at boot and hands them out by name: `getFs()`, `@FileSystem()`, `fs://` URIs |
| [File operations](02-file-operations.md) | The `fs` API: read, write, stream, copy, move, list, stat, zip, unzip, plus the helper and `_`-prefixed functional wrappers |
| [Local provider](03-local-provider.md) | `fsNative`: local disk storage sandboxed to a base path, and how to subclass it |
| [Temp file system](04-temp-file-system.md) | `fsTemp`: temp files on any backend provider, deleted by a cleanup strategy |
| [Temp cleanup strategies](05-temp-cleanup-strategies.md) | `TempCleanupStrategy`: the shipped max-age and cron strategies, and writing your own |
| [Custom providers](06-custom-providers.md) | Implements the abstract `fs` class for a new storage backend |
| [Middlewares](07-middlewares.md) | `FsMiddleware`: checks or observes every file action, eg. access control or read-only mounts |
| [Boot service and provider lookup](08-boot-service-and-provider-lookup.md) | Replaces or extends `fsService` and the `__file_provider__` lookup factory |
| [File hashing](09-file-hashing.md) | `FileHasher`: hashes files, buffers and streams; the default `DefaultFileHasher` and custom hashers |
| [File metadata](10-file-metadata.md) | `FileInfoService`: image, video and document metadata through `exiftool`, file type checks |
| [CLI commands](11-cli-commands.md) | `spinajs fs-*` commands to inspect and change any configured file system |
| [Streams](12-streams.md) | `DigestStream` and `ByteLimitStream`: hash or cap the bytes on their way to a provider |

## Extension points at a glance

| Extension point | DI token and lifetime | Default | Page |
| --- | --- | --- | --- |
| File provider | `fs` (string `'fs'`), `PerInstanceCheck` per `name` | `fsNative`, `fsTemp` | [Custom providers](06-custom-providers.md), [Local provider](03-local-provider.md#extending-fsnative) |
| File middleware | `FsMiddleware`, resolved as `Array.ofType(FsMiddleware)` per action | none | [Middlewares](07-middlewares.md) |
| Temp cleanup strategy | `TempCleanupStrategy`, `NewInstance`, picked by class name | `MaxAgeTempCleanupStrategy` | [Temp cleanup strategies](05-temp-cleanup-strategies.md) |
| File hasher | `FileHasher`, `PerInstanceCheck` per algorithm | `DefaultFileHasher` | [File hashing](09-file-hashing.md) |
| File metadata | `FileInfoService`, singleton | `DefaultFileInfo` | [File metadata](10-file-metadata.md) |
| Boot service | `fsService`, singleton | `fsService` | [Boot service and provider lookup](08-boot-service-and-provider-lookup.md) |
| Provider lookup | `'__file_provider__'` factory, registered by `FsBootstrapper` | name lookup in `'__file_provider_instance__'` | [Boot service and provider lookup](08-boot-service-and-provider-lookup.md#provider-lookup-factory) |

## Quick start

```ts sample
import { DI } from '@spinajs/di';
import { fs, fsService, getFs } from '@spinajs/fs';

// config: fs.defaultProvider = 'documents', fs.providers = [{ service: 'fsNative', name: 'documents', basePath: './data/documents' }]
export async function saveInvoice(invoiceNumber: string, pdf: Buffer): Promise<string> {
  await DI.resolve(fsService);

  const documents: fs = getFs('documents');
  await documents.mkdir('invoices');
  await documents.write(`invoices/${invoiceNumber}.pdf`, pdf);

  return documents.hash(`invoices/${invoiceNumber}.pdf`);
}
```

Configure the providers first: see [Providers and configuration](01-providers-and-configuration.md).

Every path is normalised before a provider sees it: see [Path normalisation](07-middlewares.md#path-normalisation).

## Related packages

- `@spinajs/fs-s3`, `@spinajs/fs-ftp`, `@spinajs/fs-onedrive`: remote providers built on the abstract `fs` class.
- `@spinajs/authz-fs`: ships `AuthzFsMiddleware`, which guards providers with authorization rules.
- `@spinajs/di`: resolves every provider, strategy, hasher and decorator of this package.
- `@spinajs/configuration`: supplies the `fs.*` keys.
- `@spinajs/cli`: runs the `fs-*` commands.
