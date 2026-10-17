# `@spinajs/fs-ftp`

An FTP and FTPS file provider for `@spinajs/fs`. It ships one class, `fsFTP`, which implements the abstract `fs` API on top of the [`basic-ftp`](https://www.npmjs.com/package/basic-ftp) client, so code written against `fs` reads and writes an FTP server without changes.

It does **not** support SFTP (SSH), streaming writes (`writeStream()`), temporary paths (`tmppath()`) or local path resolving (`resolvePath()` for relative paths). It does **not** reconnect: the connection opens once, when the provider resolves.

## Install

```sh
npm install @spinajs/fs-ftp
```

## Features

| Feature | What it does |
| --- | --- |
| [FTP provider](01-ftp-provider.md) | Configure `fsFTP` in `fs.providers`, how it connects at boot, and how code gets it by name |
| [File operations](02-file-operations.md) | What each `fs` method does on FTP: working directory, temp downloads, cross-provider copy and move, zip, unsupported methods |
| [Extending the FTP provider](03-extending-the-ftp-provider.md) | Subclass `fsFTP`, register it under the `fs` token, select it by `service`, override the path hooks |
| [Decorating the FTP provider](04-decorating-the-ftp-provider.md) | Wrap every `fsFTP` instance with an `FsDecorator`: read-only guards, auditing, access control |

## Quick start

Configure a provider named `ftp` next to the `fs-temp` provider it downloads into, then write and read a file.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { getFs } from '@spinajs/fs';
import '@spinajs/fs-ftp';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      fs: {
        defaultProvider: 'local',
        providers: [
          { service: 'fsNative', name: 'local', basePath: '/var/app/files' },
          { service: 'fsNative', name: 'fs-temp', basePath: '/var/app/temp' },
          { service: 'fsFTP', name: 'ftp', host: 'ftp.example.com', port: 21, user: 'app', password: 'secret' },
        ],
      },
    });
  }
}

DI.register(AppConfiguration).as(Configuration);

// after the application bootstrap has resolved fsService
export async function publishGreeting() {
  const ftp = getFs('ftp');
  await ftp.write('outbox/hello.txt', 'hello world');
  return ftp.read('outbox/hello.txt', 'utf-8');
}
```

## Related packages

- [`@spinajs/fs`](../fs/README.md): the abstract `fs` API, `fsService`, `FsDecorator`, `getFs()`, `@FileSystem()` and the local providers `fsFTP` relies on.
- `@spinajs/fs-s3`, `@spinajs/fs-onedrive`: other remote providers registered under the same `fs` token.
- `@spinajs/di`: the container `fsFTP` is registered in.
- `@spinajs/log`: the `fs` logger `fsFTP` writes connection, command and progress messages to.
