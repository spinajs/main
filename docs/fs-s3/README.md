# `@spinajs/fs-s3`

An AWS S3 file provider for [`@spinajs/fs`](../fs/README.md). Code that works with an `fs` provider reads and writes S3 objects without changes, by switching the provider name.

Its package config ships the `fs-temp-s3` local filesystem it downloads into, in the OS temp directory. S3 has no directories, so directory operations are no-ops.

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

          // optional: replaces the shipped temp filesystem fsS3 downloads into
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

## Running the package tests

The S3 suites run against LocalStack:

```sh
docker compose -f packages/fs-s3/test/docker-compose.yml up -d localstack
FS_S3_LOCALSTACK=required npm test --workspace=packages/fs-s3
docker compose -f packages/fs-s3/test/docker-compose.yml down
```

- The compose file pins `localstack/localstack:3.8.1`: newer images exit unless `LOCALSTACK_AUTH_TOKEN` is set.
- Without LocalStack the suites skip; `FS_S3_LOCALSTACK=required` makes them fail instead. `FS_S3_TEST_ENDPOINT` points them at another endpoint (default `http://localhost:4566`).
- LocalStack does not enforce `If-None-Match` between two concurrent multipart writes. The concurrent exclusive-write test runs only with `FS_S3_ATOMIC_ENDPOINT` (and `FS_S3_ATOMIC_ACCESS_KEY`, `FS_S3_ATOMIC_SECRET_KEY`, `FS_S3_ATOMIC_REGION`) set to an S3 that does, such as AWS.

## Related packages

- [`@spinajs/fs`](../fs/README.md): the `fs` abstraction, `fsService` that creates providers, `fsTemp`, `FileInfoService` and `FsMiddleware`.
- [`@spinajs/configuration`](../configuration/README.md): supplies `fs.s3.config` and the provider list.
- [`@spinajs/di`](../di/README.md): registers `fsS3` and resolves the signer named in configuration.
- [`@spinajs/fs-ftp`](../fs-ftp/README.md) and [`@spinajs/fs-onedrive`](../fs-onedrive/README.md): other remote providers behind the same `fs` API.
