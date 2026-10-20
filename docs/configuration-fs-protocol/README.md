# `@spinajs/configuration-fs-protocol`

Adds the `fs-path://` configuration protocol: a config value `fs-path://<provider>/<path>` turns into the absolute path that the named `@spinajs/fs` provider resolves `<path>` to.

It does **not** read, create or check files or folders. It only computes a path string, lazily, on first read after the file providers exist. It does **not** work for providers without local paths (`fs-s3`, `fs-ftp`, `fs-onedrive`).

## Install

```sh
npm install @spinajs/configuration-fs-protocol
```

## Features

| Feature | What it does |
| --- | --- |
| [`fs-path://` values](01-fs-path-values.md) | Write a provider-relative path in config, read back an absolute path once `fsService` has registered the providers |
| [Replacing or extending the protocol](02-replacing-or-extending-the-protocol.md) | `ConfigurationFsPathProtocol` in DI: subclass it, swap it out, or add a sibling protocol that reuses its resolver |
| [Provider path resolution](03-provider-path-resolution.md) | How the named provider turns the path into a string; write a provider whose `resolvePath()` changes every `fs-path://` value |

## Quick start

Point the invoice archive at a folder of the `fs-data` provider. The config file:

```ts sample
const config = {
  fs: {
    defaultProvider: 'fs-data',
    providers: [{ service: 'fsNative', name: 'fs-data', basePath: '/var/lib/billing' }],
  },
  invoices: {
    // resolves to /var/lib/billing/invoices
    archiveDir: 'fs-path://fs-data/invoices',
  },
};

export default config;
```

Import the package once, before `Configuration` is resolved, then read the value:

```ts sample
import '@spinajs/configuration-fs-protocol';
import { Config } from '@spinajs/configuration';
import { AsyncService, Injectable } from '@spinajs/di';

@Injectable()
export class InvoiceArchive extends AsyncService {
  // null until fsService has registered the providers, then the absolute path
  @Config('invoices.archiveDir')
  protected ArchiveDir: string | null;

  public archivePath(): string {
    if (!this.ArchiveDir) {
      throw new Error('invoice archive filesystem is not ready');
    }
    return this.ArchiveDir;
  }
}
```

## Related packages

- [`@spinajs/configuration`](../configuration/README.md): finds protocol values at load time and dereferences them on read.
- [`@spinajs/configuration-common`](../configuration-common/README.md): `ConfigVarProtocol` and `ConfigVar`, the contract this package implements.
- [`@spinajs/fs`](../fs/README.md): the file providers, `fsService`, `getFs()` and `resolvePath()` the protocol relies on.
- [`@spinajs/configuration-aws-secretmanager-protocol`](../configuration-aws-secretmanager-protocol/README.md): another `ConfigVarProtocol`, for secrets.
