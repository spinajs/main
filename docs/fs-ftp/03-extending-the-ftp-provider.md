# Extending the FTP provider

Subclass `fsFTP` to change how it connects, navigates or transfers files, register the subclass under the `fs` token, and select it per provider with `service`. The stock `fsFTP` stays available for every other entry.

## How it works

1. `fsService` collects every class registered under `fs` with `DI.RootContainer.Registry.getTypes(fs)`.
2. For each `fs.providers` entry it picks the class whose **class name** equals `service`. Your subclass named `fsFTPResilient` is selected by `service: 'fsFTPResilient'`.
3. `DI.resolve(subclass, [config])` creates it with the entry as `Options` and awaits its `resolve()`. With `@PerInstanceCheck()`, each `name` gets one instance.
4. The instance is published under its `name` and passed through the `FsDecorator`s, like any other provider.

Registration happens when the module with `@Injectable('fs')` is imported. Import it before the application resolves `fsService`, in the same file that imports `@spinajs/fs-ftp` or in your application entry.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| FTP provider class | `fs`, `@PerInstanceCheck()` (one instance per `name`), selected by class name from `service` | `fsFTP` | your subclasses; any other `fs` implementation | `@Injectable('fs')` + `@PerInstanceCheck()` on a subclass, then `service: '<ClassName>'` |
| Root reset hook | `protected _restoreRootDir()` | `pwd`, then `cd ..` per segment | | Override to reconnect, log or use `cd /` |
| Directory hook | `protected _setWorkingDir(path)` | `cd /<dirname(path)>` (an absolute dirname as it is), or `cd .` for root files | | Override to prefix a base directory |
| Directory creation hook | `protected _ensureDir(path)` | `Client.ensureDir(dirname(path))`, then `_setWorkingDir(path)` | | Override to skip creation or set permissions |
| Connection | `public resolve()` | `new Client()`, `Client.access()`, progress logging | | Override, call `super.resolve()`, then tune `this.FtpClient` |
| Shutdown | `public dispose()`, called by `DI.dispose()` for cached services | `this.FtpClient.close()` | | Override to add shutdown work, then call `super.dispose()` |
| Unsupported methods | `writeStream()`, `tmppath()`, `resolvePath()` | throw `MethodNotImplemented` | | Override with an implementation |

Protected members available to a subclass:

| Member | Type | Meaning |
| --- | --- | --- |
| `Options` | `IFtpConfig` (public) | The provider's config entry; add your own keys to it |
| `FtpClient` | `Client` from `basic-ftp` | The connection; created in `resolve()` |
| `TempFs` | `fs` | Getter for the provider named `fs-temp` |
| `Logger` | `Log` | The `fs` logger |
| `FileInfo` | `FileInfoService` | Injected file info service |

## Important behaviour

- `@Injectable('fs')` on `fsFTP` registers **only** `fsFTP`. A subclass without its own `@Injectable('fs')` is never found by `fsService`.
- Selection uses the bare class name. Two classes with the same name under `fs` (in different modules) make the first registered one win; give subclasses unique names.
- `@PerInstanceCheck()` relies on `fs.__checkInstance__()`, which compares `Name` with `creationOptions[0].name`. Keep `Name` returning `Options.name`.
- Not every method calls every hook. `list()`, `mkdir()` and `rename()` (and so same-server `move()`) call `_restoreRootDir()` but not `_setWorkingDir()`; override them too when a directory hook must apply everywhere.
- Your subclass replaces nothing by itself: entries with `service: 'fsFTP'` keep using the stock class.

## Best practices

- Call `super.resolve()` first in an overridden `resolve()`; it creates `FtpClient` and connects.
- Read new config keys from `this.Options` and type them with an interface that extends `IFtpConfig`.
- Keep every call to `FtpClient` sequential: one `basic-ftp` client runs one command at a time.
- Wrap a provider (logging, guards, queues) with an [`FsDecorator`](04-decorating-the-ftp-provider.md) instead of a subclass when the change applies to every provider type.

## Patterns and antipatterns

```ts
// Don't: no @Injectable('fs'); fsService throws "Type fsFTPResilient not registered"
export class fsFTPResilient extends fsFTP {}

// Do
@Injectable('fs')
@PerInstanceCheck()
export class fsFTPResilient extends fsFTP {}
```

```ts
// Don't: a second Client bypasses the hooks and doubles the connections
public async resolve() {
  await super.resolve();
  this.Mirror = new Client();
}

// Do: tune the client fsFTP already opened
public async resolve() {
  await super.resolve();
  this.FtpClient.ftp.socket.setKeepAlive(true, 30000);
}
```

## Examples

### Reconnect after the server drops an idle connection

`basic-ftp` closes the client after a timeout or socket error, and `Client.access()` is the way to reopen it. Every method that talks to the server calls `_restoreRootDir()` first, so the check fits there.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { getFs } from '@spinajs/fs';
import { fsFTP } from '@spinajs/fs-ftp';

@Injectable('fs')
@PerInstanceCheck()
export class fsFTPResilient extends fsFTP {
  protected async _restoreRootDir() {
    if (this.FtpClient.closed) {
      this.Logger.warn({ provider: this.Name }, 'FTP connection of ${provider} closed, reconnecting');

      await this.FtpClient.access({
        host: this.Options.host,
        port: this.Options.port ?? 21,
        user: this.Options.user,
        password: this.Options.password,
        secure: this.Options.secure ?? false,
      });
    }

    await super._restoreRootDir();
  }
}

// fs.providers entry:
// { service: 'fsFTPResilient', name: 'ftp-partner', host: 'ftp.partner.example', user: 'reports', password: '...' }

export async function publishDailyReport(day: string, csv: string) {
  await getFs('ftp-partner').write(`incoming/${day}.csv`, csv, 'utf-8');
}
```

### Run your own work on shutdown

`fsFTP.dispose()` closes the connection. Override it to add your own work and call `super.dispose()`.

```ts sample
import { DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsFTP } from '@spinajs/fs-ftp';

@Injectable('fs')
@PerInstanceCheck()
export class fsFTPClosing extends fsFTP {
  public async dispose(): Promise<void> {
    await super.dispose();
    this.Logger.info({ provider: this.Name }, 'FTP connection of ${provider} closed');
  }
}

// fs.providers entry: { service: 'fsFTPClosing', name: 'ftp', host: 'ftp.example.com', user: 'app', password: '...' }

process.once('SIGTERM', () => {
  void DI.dispose();
});
```

### Add streaming uploads

`fsFTP.writeStream()` throws. This subclass returns a `PassThrough` that `basic-ftp` uploads from, plus an `uploaded` promise that settles when the server confirms the transfer.

```ts sample
import { basename } from 'path';
import { PassThrough } from 'stream';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { getFs } from '@spinajs/fs';
import { fsFTP } from '@spinajs/fs-ftp';

export type FtpUploadStream = PassThrough & { uploaded: Promise<void> };

@Injectable('fs')
@PerInstanceCheck()
export class fsFTPStreaming extends fsFTP {
  public async writeStream(path: string, source?: BufferEncoding | NodeJS.ReadableStream, _encoding?: BufferEncoding): Promise<FtpUploadStream> {
    const pass = new PassThrough();

    await this._restoreRootDir();
    await this._ensureDir(path);

    const upload = this.FtpClient.uploadFrom(pass, basename(path));
    upload.catch((err: Error) => pass.destroy(err));

    if (source && typeof source !== 'string') {
      source.pipe(pass);
    }

    return Object.assign(pass, { uploaded: upload.then(() => undefined) });
  }
}

// fs.providers entry: { service: 'fsFTPStreaming', name: 'ftp-backup', host: 'backup.example.com', user: 'backup', password: '...' }

export async function backupDatabaseDump(localDump: string, day: string) {
  const ftp = getFs('ftp-backup');
  const out = (await ftp.writeStream(`dumps/${day}.sql.gz`)) as FtpUploadStream;

  await pipeline(createReadStream(localDump), out);

  // the provider is free for the next call only after the server confirms
  await out.uploaded;
}
```

## Related

- [FTP provider](01-ftp-provider.md): config keys, connection, `fs-temp`.
- [File operations](02-file-operations.md): which methods call the hooks.
- [Decorating the FTP provider](04-decorating-the-ftp-provider.md): wrap instances instead of subclassing.
- [`@spinajs/fs`](../fs/README.md): the abstract `fs` class, for a provider written from scratch.
