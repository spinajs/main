# Upload middlewares and uploaders

Two seams shape what happens to an uploaded file between the multipart parser and the action. A `FileUploadMiddleware` inspects, validates or transforms each file while it is still in the local upload directory. A `FormFileUploader` moves the file to its storage afterwards. Both are chosen per route in the `@File()` options, and middlewares also globally in `http.upload.middlewares`.

## How it works

1. `FromFile` builds the list of middleware descriptors: `http.upload.middlewares` first, then `options.middlewares` of the `@File()`.
2. It resolves each descriptor:
   - a string or a class: `DI.resolve(descriptor)`;
   - `{ service, options }`: `DI.resolve(service, [options])`, so `options` is the first constructor argument.
3. For each middleware in order, for each file, it awaits `beforeUpload(file, uploadOptions)` and merges the returned object into the file with `Object.assign`.
4. When `options.fs` differs from the default upload provider, `ImmediateFileUploader` copies every file from the upload directory to `file.Provider` and deletes the temporary copy.
5. When `options.uploader` is set, it resolves it like a middleware descriptor (`DI.resolve(service, [options ?? {}])`) and awaits `upload(file)` for every file. The returned files replace the ones the action receives.
6. A middleware or uploader that throws stops the request; the temporary files are deleted and the error goes to the [error handler](11-error-handling.md).

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.upload.middlewares` | `UploadFileMiddlewareDescriptor[]` | `['FileInfoMiddleware']` | class name strings, classes, `{ service, options }` | Middlewares for every `@File()`/`@Files()`, before the route's own. |

```ts
export default {
  http: {
    upload: {
      // Every upload gets content-based info and is refused above 50 MB.
      middlewares: ['FileInfoMiddleware', { service: 'FileValidationMiddleware', options: { size: { max: 50 * 1024 * 1024 } } }],
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FileUploadMiddleware` (abstract) | No list: each is resolved by the name or class in its descriptor; the class's own lifetime applies | `FileInfoMiddleware` (from `http.upload.middlewares`) | `FileValidationMiddleware`, `ZipFileTransformer`, `UnzipFileTransformer`, `AuthzUploadMiddleware` (`@spinajs/authz-fs`) | Extend it, implement `beforeUpload()`, register with `@Injectable()` (for string names) and list it in `options.middlewares` or `http.upload.middlewares`. Replace a shipped one with `DI.register(Mine).as(FileInfoMiddleware)`. |
| `FormFileUploader` (abstract) | No list: resolved from `options.uploader` | `ImmediateFileUploader` (used for `options.fs`, not exported) | `HttpLazyFileUploader` (`@spinajs/http-lazy-file-uploader`) | Extend it, implement `upload()`, name it in `options.uploader`. |

### Shipped middlewares

| Middleware | Lifetime | Options (constructor) | Effect |
| --- | --- | --- | --- |
| `FileInfoMiddleware` | singleton | none | When the route sets `fileInfo: true`, sets `Info` from `FileInfoService.getInfo()` (`@spinajs/fs`): content MIME type, width, height, ... Logs a warning and does nothing when `FileInfoService` is not available. |
| `FileValidationMiddleware` | `@NewInstance()` | `FileValidationRules` | Checks size, type, proportions and resolution; fetches `Info` itself when a rule needs it. Throws `ValidationFailed` (400). |
| `ZipFileTransformer` | singleton | none | Zips the file inside `file.Provider`, deletes the original, sets `BaseName`, `Name` (`<name>.zip`), `Size`, `Type: 'application/zip'` and `Data: { OriginalName, OriginalSize }`. |
| `UnzipFileTransformer` | singleton | none | Unzips the file inside `file.Provider`, deletes the archive, sets `BaseName`, `Size`, `Type: 'unknown'` and `Data`. |

`FileValidationRules`:

| Rule | Type | Check |
| --- | --- | --- |
| `size.min`, `size.max` | `number` (bytes, inclusive) | `file.Size` |
| `types` | `FileTypeEnum[]` | `Info.MimeType` equals one entry (case-insensitive); an entry ending in `/*` matches the category |
| `proportions` | `FileProportions[]` (`'16:9'`, `'4:3'`, `'1:1'`, `'3:4'`, `'9:16'`, `'Free'`) | `Info.Width / Info.Height` within 1% of **every** listed ratio; `Free` is skipped |
| `resolution.minWidth`, `maxWidth`, `minHeight`, `maxHeight` | `number` (pixels) | `Info.Width`, `Info.Height` |

### `FileUploadMiddleware`: custom implementation

`beforeUpload(file, options)` gets the file while it is in the upload directory (`file.OriginalFile.filepath` is a local path). Return the file, or an object with the fields to change. Mark a middleware that takes constructor options `@NewInstance()`; a singleton keeps the options of its first resolve.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { BaseController, BasePath, File, FileUploadMiddleware, IUploadedFile, IUploadOptions, Ok, Post } from '@spinajs/http';
import { extname } from 'path';

export interface ISafeNameOptions {
  maxLength: number;
}

/** Replaces the client's file name with a safe, short one and keeps the original in Data. */
@Injectable()
@NewInstance()
export class SafeFileNameMiddleware extends FileUploadMiddleware {
  constructor(protected Options: ISafeNameOptions = { maxLength: 64 }) {
    super();
  }

  public async beforeUpload(file: IUploadedFile, _options?: IUploadOptions): Promise<IUploadedFile> {
    const ext = extname(file.Name).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const stem = file.Name.slice(0, file.Name.length - extname(file.Name).length)
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .slice(0, this.Options.maxLength);

    return {
      ...file,
      Name: `${stem || 'file'}${ext}`,
      Data: { ...(file.Data ?? {}), ClientName: file.Name },
    };
  }
}

@BasePath('attachments')
export class AttachmentsController extends BaseController {
  @Post('/')
  public upload(@File({ middlewares: [{ service: SafeFileNameMiddleware, options: { maxLength: 40 } }] }) file: IUploadedFile) {
    return new Ok({ name: file.Name, original: file.Data?.ClientName });
  }
}
```

### `FormFileUploader`: custom implementation

`upload(file)` runs after the middlewares and after the `options.fs` copy. `file.Provider` holds the file under `file.BaseName`. Return the file with the fields that changed; set `Provider` to `null` when the file no longer lives in a provider the app can read.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { getFs } from '@spinajs/fs';
import { BaseController, BasePath, File, FormFileUploader, IUploadedFile, Ok, Post } from '@spinajs/http';

export interface IQuarantineOptions {
  /** fs provider name for files waiting for a virus scan */
  fs: string;
}

/** Moves every upload to a quarantine provider under a dated folder. */
@Injectable()
@NewInstance()
export class QuarantineUploader extends FormFileUploader {
  constructor(protected Options: IQuarantineOptions) {
    super();
  }

  public async upload(file: IUploadedFile): Promise<IUploadedFile> {
    const target = getFs(this.Options.fs);
    if (!file.Provider || !target) {
      throw new IOFail(`cannot quarantine ${file.Name}: provider missing`);
    }

    const day = new Date().toISOString().slice(0, 10);
    const path = `${day}/${file.BaseName}`;

    await file.Provider.copy(file.BaseName, path, target);
    await file.Provider.rm(file.BaseName);

    return { ...file, BaseName: path, Provider: target };
  }
}

@BasePath('inbox')
export class InboxController extends BaseController {
  @Post('/')
  public receive(@File({ uploader: { service: QuarantineUploader, options: { fs: 'quarantine' } } }) file: IUploadedFile) {
    return new Ok({ queued: file.BaseName });
  }
}
```

## Important behaviour

- Middlewares run in descriptor order, and every file passes one middleware before the next middleware starts.
- `file.Provider` is the **target** provider (`options.fs`) during the middlewares, while the file itself is still in the upload directory. `ZipFileTransformer` and `UnzipFileTransformer` work on `file.Provider`, so they only work when `options.fs` is not set (the target is the upload directory).
- `FileValidationMiddleware` with several `proportions` requires the image to match all of them; list one ratio per route.
- `FileTypeEnum.any` (`'*/*'`) matches nothing in `FileValidationMiddleware`: the wildcard rule compares the category before `/*`, here `*`.
- `FileInfoMiddleware` only acts when the route sets `fileInfo: true`, even though it runs on every upload by default.
- The DI cache is keyed by class **name**: an upload middleware and a data transformer both named `TestTransformer` collide.
- An uploader is resolved per request with `[options]`. A singleton uploader (such as `HttpLazyFileUploader`, `@Injectable()` only) keeps the options of its first resolve; use one options set per uploader class, or make your uploader `@NewInstance()`.
- `ImmediateFileUploader` is not exported from the package entry; it runs automatically for `options.fs`.

## Best practices

- Put the checks that apply everywhere (size cap, file info) in `http.upload.middlewares`, and type rules per route.
- Validate before you transform: list `FileValidationMiddleware` before `ZipFileTransformer`.
- Throw `ValidationFailed` or `BadRequest` from a middleware to answer 400; other errors answer 500.

## Patterns and antipatterns

```ts
// Don't: a singleton middleware with options; the second route silently gets maxLength 40 too.
@Injectable()
export class SafeFileNameMiddleware extends FileUploadMiddleware {
  constructor(protected Options: ISafeNameOptions) { super(); }
}

// Do
@Injectable()
@NewInstance()
export class SafeFileNameMiddleware extends FileUploadMiddleware {
  constructor(protected Options: ISafeNameOptions) { super(); }
}
```

## Examples

### Accept 16:9 cover images between 1280 and 3840 pixels wide

```ts sample
import { BaseController, BasePath, File, FileProportions, FileTypeEnum, FileValidationMiddleware, IUploadedFile, Ok, Post } from '@spinajs/http';

@BasePath('covers')
export class CoversController extends BaseController {
  @Post('/')
  public upload(
    @File({
      required: true,
      maxFileSize: 8 * 1024 * 1024,
      fileInfo: true,
      middlewares: [
        {
          service: FileValidationMiddleware,
          options: {
            types: [FileTypeEnum.jpg, FileTypeEnum.png, FileTypeEnum.webp],
            proportions: [FileProportions['16:9']],
            resolution: { minWidth: 1280, maxWidth: 3840 },
          },
        },
      ],
    })
    cover: IUploadedFile,
  ) {
    return new Ok({ width: cover.Info?.Width, height: cover.Info?.Height });
  }
}
```

## Related

- [File uploads](08-file-uploads.md): the full upload flow and `IUploadOptions`.
- [`@spinajs/fs`](../fs/README.md): providers, `copy`, `zip`, `FileInfoService`.
- [`@spinajs/http-lazy-file-uploader`](../http-lazy-file-uploader/README.md): an uploader that copies in a background job.
- `@spinajs/authz-fs`: `AuthzUploadMiddleware`, a write-permission check on uploads.
