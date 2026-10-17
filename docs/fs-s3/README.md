# `@spinajs/fs-s3`

An AWS S3 file provider for [`@spinajs/fs`](../fs/README.md). Code that works with an `fs` provider reads and writes S3 objects without changes, by switching the provider name.

It does **not** create a temporary filesystem for you: the `fs-temp-s3` provider it downloads into must be in your configuration. S3 has no directories, so directory operations are no-ops.

## Install

```sh
npm install @spinajs/fs @spinajs/fs-s3
```

## Features

| Feature | What it does |
| --- | --- |
| [S3 file provider](01-s3-file-provider.md) | `fsS3`: one bucket as an `fs` provider, its configuration and every file operation. |
| [Temporary files](02-temporary-files.md) | The `fs-temp-s3` local filesystem that downloads, `read`, `append`, `zip` and `unzip` go through. |
| [Object metadata](03-object-metadata.md) | File info and hashes stored as S3 user metadata on upload; `getMetadata`, `setMetadata`, `hash`. |
| [Signed URLs](04-signed-urls.md) | Time-limited download links through S3 presigning or CloudFront, and custom signers. |
| [Custom S3 provider](05-custom-s3-provider.md) | Subclass `fsS3` for per-account credentials, extra upload headers or another temp filesystem. |

## Quick start

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { FileSystem, fs } from '@spinajs/fs';
import '@spinajs/fs-s3';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      fs: {
        defaultProvider: 'local',
        s3: {
          config: {
            region: 'eu-central-1',
            credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
          },
        },
        providers: [
          { service: 'fsNative', name: 'local', basePath: './data' },
          { service: 'fsS3', name: 'invoices', bucket: 'acme-invoices', createBucketIfNotExists: false },

          // required by fsS3: local disk for downloads
          { service: 'fsNative', name: 'fs-temp-s3-local', basePath: './data/temp-s3' },
          { service: 'fsTemp', name: 'fs-temp-s3', provider: 'fs-temp-s3-local', cleanup: true, cleanupInterval: 3600 * 1000, maxFileAge: 24 * 3600 },
        ],
      },
    });
  }
}

@Injectable()
export class InvoiceArchive {
  @FileSystem('invoices')
  protected Invoices: fs;

  public async store(invoiceNo: string, pdf: Uint8Array) {
    await this.Invoices.write(`2026/${invoiceNo}.pdf`, pdf);
  }

  public async load(invoiceNo: string) {
    return this.Invoices.read(`2026/${invoiceNo}.pdf`);
  }
}
```

## Related packages

- [`@spinajs/fs`](../fs/README.md): the `fs` abstraction, `fsService` that creates providers, `fsTemp`, `FileInfoService` and `FsDecorator`.
- [`@spinajs/configuration`](../configuration/README.md): supplies `fs.s3.config` and the provider list.
- [`@spinajs/di`](../di/README.md): registers `fsS3` and resolves the signer named in configuration.
- [`@spinajs/fs-ftp`](../fs-ftp/README.md) and [`@spinajs/fs-onedrive`](../fs-onedrive/README.md): other remote providers behind the same `fs` API.
