# Customizing the upload service

`ConfigFileUploads` and the services it uses are DI registrations, so a project can change the upload pipeline without forking it: subclass the service to add steps around `accept`, `commit` and `discard`, swap the mime detector, or point entries at another storage provider.

## How it works

1. `@Injectable()` on `ConfigFileUploads` registers the class under itself when its module loads. The default lifetime is singleton.
2. A consumer gets it with `@Autoinject() protected Uploads!: ConfigFileUploads` or `await DI.resolve(ConfigFileUploads)`.
3. DI resolves the **last** class registered under `ConfigFileUploads`. A subclass registered with `@Injectable(ConfigFileUploads)` or `DI.register(MySubclass).as(ConfigFileUploads)` therefore replaces it for every consumer.
4. Inside the service, `@Autoinject()` resolves `FileInfoService` and `DataValidator`; `@Logger('configuration-http')` provides `Log`. Each is resolved through DI too, so replacing `FileInfoService` changes mime detection here.
5. On each upload, `getFs(meta.file.fs)` resolves the storage provider by name, and `resolveConfigFileValidator()` the [validator](06-file-validators.md).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConfigFileUploads` | `ConfigFileUploads`, singleton, self-registered by `@Injectable()` | `ConfigFileUploads` | Your subclass | `@Injectable(ConfigFileUploads)` on a subclass, imported before the first resolution. Override `accept`, `commit`, `discard` and call `super`. |
| `FileInfoService` | `FileInfoService`, singleton, `@Autoinject()` | `DefaultFileInfo` (`exiftool`, `fs.fileInfo.exifToolPath`, `fs.fileInfo.timeout`) from `@spinajs/fs` | Your detector | `DI.register(MyFileInfo).as(FileInfoService)` before the first resolution. Affects every user of `FileInfoService`, not only uploads. |
| `DataValidator` | `DataValidator`, singleton, `@Autoinject()` | `DataValidator` of `@spinajs/validation` | — | Add value schemas instead ([Value schemas](03-value-schemas.md)). |
| Storage provider | Named `fs` service of `@spinajs/fs`, `getFs(meta.file.fs)` per upload | per entry | `fsNative` and the other `@spinajs/fs-*` providers | Add a provider to `fs.providers` and name it in `meta.file.fs`. |

### What a subclass can change

| Member | Visibility | Use |
| --- | --- | --- |
| `accept(entry, file)` | public | Wrap: checks before `super.accept`, follow-up after it. |
| `commit(entry, fileName)` | public | Wrap: notify, audit, or invalidate a cache after `super.commit`. |
| `discard(accepted)` | public | Wrap: extra cleanup next to `super.discard`. |
| `FileInfo` | protected | The injected `FileInfoService`. |
| `Validator` | protected | The injected `DataValidator`. |
| `Log` | protected | The `configuration-http` logger. |

The steps inside `accept` (rules, mime detection, validator lookup, provider lookup, stored-name check) are private: a subclass cannot change their order or skip one.

### `ConfigFileUploads`: custom implementation

A subclass that tells the sales team when an offer template changes, and refuses uploads to a frozen entry. It takes its own dependency through DI, so the notifier is replaceable as well.

```ts sample
import { rm } from 'node:fs/promises';
import { Autoinject, Injectable } from '@spinajs/di';
import type { IUploadedFile } from '@spinajs/http';
import { DbConfig } from '@spinajs/configuration-db-source';
import { ConfigFileRejected, ConfigFileUploads } from '@spinajs/configuration-http';
import type { IAcceptedConfigFile } from '@spinajs/configuration-http';
import { Log, Logger } from '@spinajs/log';

/** Replace with a mail or chat implementation through DI.register(...).as(TemplateChangeNotifier). */
@Injectable()
export class TemplateChangeNotifier {
  @Logger('templates')
  protected Log!: Log;

  public async changed(slug: string, fileName: string): Promise<void> {
    this.Log.info({ slug, fileName }, 'Template ${slug} now points at ${fileName}');
  }
}

const FROZEN_GROUPS = ['legal'];

@Injectable(ConfigFileUploads)
export class NotifyingConfigFileUploads extends ConfigFileUploads {
  @Autoinject()
  protected Notifier!: TemplateChangeNotifier;

  public async accept(entry: DbConfig, file: IUploadedFile): Promise<IAcceptedConfigFile> {
    if (FROZEN_GROUPS.includes(entry.Group)) {
      // super.accept() removes the temp file; rejecting before it means removing it here
      await rm(file.OriginalFile.filepath, { force: true });
      throw new ConfigFileRejected(`Files of ${entry.Label ?? entry.Slug} are frozen`);
    }
    return super.accept(entry, file);
  }

  public async commit(entry: DbConfig, fileName: string): Promise<DbConfig> {
    const committed = await super.commit(entry, fileName);
    await this.Notifier.changed(entry.Slug, fileName);
    return committed;
  }
}
```

Every consumer that injects `ConfigFileUploads`, such as the upload controller of [File uploads](05-file-uploads.md#upload-a-new-offer-template-with-history), now gets `NotifyingConfigFileUploads` as long as its module is imported at startup.

### `FileInfoService`: custom mime detection

`DefaultFileInfo` needs `exiftool`. On a host without it, or when only a few types matter, register a detector that reads magic bytes. `mimeTypes` rules then compare against its answer.

```ts sample
import { open } from 'node:fs/promises';
import { DI } from '@spinajs/di';
import { FileInfoService } from '@spinajs/fs';
import type { IFileInfo } from '@spinajs/fs';

const SIGNATURES: [string, string][] = [
  ['PK\u0003\u0004', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['%PDF', 'application/pdf'],
  ['\u0089PNG', 'image/png'],
];

/** Detects the few types configuration entries accept; everything else reads as unknown. */
export class MagicBytesFileInfo extends FileInfoService {
  public async getInfo(pathToFile: string): Promise<IFileInfo> {
    const handle = await open(pathToFile, 'r');
    try {
      const head = Buffer.alloc(8);
      await handle.read(head, 0, head.length, 0);
      const { size } = await handle.stat();
      const text = head.toString('latin1');
      const match = SIGNATURES.find(([magic]) => text.startsWith(magic));
      return { FileSize: size, MimeType: match?.[1] };
    } finally {
      await handle.close();
    }
  }

  public getInfoFromStream(): Promise<IFileInfo> {
    return Promise.reject(new Error('MagicBytesFileInfo reads files only'));
  }
}

// Before anything resolves FileInfoService; it applies application-wide.
DI.register(MagicBytesFileInfo).as(FileInfoService);
```

A `MimeType` of `undefined` reaches the rules as `''`, so an entry with `mimeTypes` set refuses unknown content.

### Storage provider: per-entry location

Each file entry names its provider in `meta.file.fs`. Different entries can store on different providers: local disk for templates, object storage for large imports. Configure the provider in `fs.providers`:

```ts sample
export default {
  fs: {
    providers: [
      { service: 'fsNative', name: 'fs-templates', basePath: '/var/app/config-files/templates' },
      { service: 'fsNative', name: 'fs-pricing', basePath: '/var/app/config-files/pricing' },
    ],
  },
};
```

`accept` throws a plain `Error` naming the slug and the provider when the name is not registered; `discard` only logs it.

## Important behaviour

- Register a replacement before the first resolution of `ConfigFileUploads`: the singleton is cached after that. An `@Injectable(ConfigFileUploads)` class in a module imported at startup is in time.
- Two subclasses registered under `ConfigFileUploads`: the last registered wins, and the other is never used.
- Rejecting in an `accept` override **before** `super.accept()` leaves the temp file in place; remove it yourself, as the example does.
- `commit` restores `entry.Value` on failure inside `super.commit`; an override that throws **after** `super.commit` returns leaves the new value stored.
- A `FileInfoService` replacement affects `@spinajs/fs` and `@spinajs/http` file info everywhere in the app.

## Best practices

- Wrap, do not reimplement: call `super.accept` / `super.commit` so the rules, the slug schema check and the temp file cleanup stay in force.
- Put per-entry content checks in a [`ConfigFileValidator`](06-file-validators.md); put cross-cutting steps (audit, notifications, quotas) in a subclass.
- Give each kind of file its own provider so retention and backups can differ per kind.

## Patterns and antipatterns

```ts
// Don't: commit from inside accept. The route can no longer record history or discard on failure.
public async accept(entry: DbConfig, file: IUploadedFile) {
  const accepted = await super.accept(entry, file);
  await super.commit(entry, accepted.fileName);
  return accepted;
}

// Do: keep accept and commit separate and let the route compose them.
public async accept(entry: DbConfig, file: IUploadedFile) {
  const accepted = await super.accept(entry, file);
  this.Log.info({ slug: entry.Slug, hash: accepted.hash }, 'Accepted a file for ${slug}');
  return accepted;
}
```

## Related

- [File uploads](05-file-uploads.md): the pipeline these classes plug into.
- [File validators](06-file-validators.md): per-entry content checks.
- [`@spinajs/fs`](../fs/README.md): providers, `FileInfoService`, `DefaultFileInfo` options.
- [`@spinajs/di`](../di/README.md): registration, lifetimes and resolution order.
