# Custom uploaders and jobs

`HttpLazyFileUploader` is one implementation of the `FormFileUploader` contract from `@spinajs/http`. You can subclass it, replace it in DI for every route, or write your own uploader that emits your own queue job.

## How it works

1. `@File({ uploader })` stores the uploader descriptor on the route: a class, a registered name, or `{ service, options }`.
2. On each request `FromFile.extract()` runs `DI.resolve(service, [options])`. `options` is `uploader.options`, or `{}` for a bare class or name.
3. DI follows the registrations for that name: the class registered last under `HttpLazyFileUploader` wins.
4. The class's lifetime decides whether `options` is used: a singleton keeps the instance (and options) of its first resolve, a `@NewInstance()` class is built per request with that route's options.
5. `FromFile.extract()` calls `upload(file)` for every file of the field and gives the controller what `upload()` returns.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FormFileUploader` | abstract class from `@spinajs/http`; never resolved by its own name, only through the route's `uploader` | none (no uploader runs unless the route sets one) | `HttpLazyFileUploader`, `ImmediateFileUploader` | Extend it and implement `upload(file): Promise<IUploadedFile>`; set the class on the route. |
| `HttpLazyFileUploader` | name `HttpLazyFileUploader`, `@Injectable()`, singleton | `HttpLazyFileUploader` | subclasses you register | Subclass and override `upload()` (call `super.upload(file)` to queue the copy). Add `@NewInstance()` for per-route options. Replace for every route with `DI.register(MyUploader).as(HttpLazyFileUploader)`. |
| `HttpLazyFileUploader.Options` | constructor argument, `{ fs: string; deleteAfterUpload?: boolean }` | from `uploader.options` | | A subclass may accept more keys; read them from `this.Options`. |
| queue job | any `QueueJob` subclass with `@Job()` | `LazyUploadJob` (not exported) | your own job | Emit it from your own uploader and consume it in your worker. |

Register a replacement before the first upload request: the singleton is cached on its first resolve. Importing a module with `@Injectable()` registers the class under its name, so `uploader: 'MyUploader'` works once that module is loaded.

## Use different targets per route

The shipped uploader is a singleton, so only the first route's `fs` is used. A `@NewInstance()` subclass is built per request with its route's options.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { BaseController, BasePath, File, IUploadedFile, Ok, Post } from '@spinajs/http';
import { HttpLazyFileUploader } from '@spinajs/http-lazy-file-uploader';

@Injectable()
@NewInstance()
export class PerRouteLazyUploader extends HttpLazyFileUploader {}

@BasePath('profile')
export class ProfileController extends BaseController {
  @Post()
  public async avatar(@File({ uploader: { service: PerRouteLazyUploader, options: { fs: 'avatars-s3' } } }) avatar: IUploadedFile) {
    return new Ok({ key: avatar.BaseName });
  }

  @Post()
  public async cv(@File({ uploader: { service: PerRouteLazyUploader, options: { fs: 'documents-s3' } } }) cv: IUploadedFile) {
    return new Ok({ key: cv.BaseName });
  }
}
```

## Replace the uploader for every route

Subclass `HttpLazyFileUploader` and register it under its name. Routes that name `HttpLazyFileUploader` then get your class. This one fails the request when the target filesystem is not configured, instead of failing the job later.

```ts sample
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { getFs } from '@spinajs/fs';
import { IUploadedFile } from '@spinajs/http';
import { HttpLazyFileUploader } from '@spinajs/http-lazy-file-uploader';

@Injectable()
@NewInstance()
export class CheckedLazyUploader extends HttpLazyFileUploader {
  public async upload(file: IUploadedFile): Promise<IUploadedFile> {
    // getFs throws ResolveException for a provider name that is not configured
    getFs(this.Options.fs);
    return super.upload(file);
  }
}

// at application start, before the first upload request
DI.register(CheckedLazyUploader).as(HttpLazyFileUploader);
```

## Write your own uploader and job

Write your own `FormFileUploader` when you need the job id in the response, extra job fields, or a different job. This uploader emits `MediaImportJob` and puts the job id in `file.Data`, so the client can poll the job (eg. with `@spinajs/queue-http-progress`).

```ts sample
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { getFs } from '@spinajs/fs';
import { BaseController, BasePath, File, FormFileUploader, IUploadedFile, Ok, Post } from '@spinajs/http';
import { Job, JobProgressCallback, QueueJob, QueueService } from '@spinajs/queue';

@Job({ runAs: 'initiator' })
@NewInstance()
export class MediaImportJob extends QueueJob {
  public SourceFs!: string;
  public TargetFs!: string;
  public Path!: string;
  public OriginalName!: string;

  public async execute(progress: JobProgressCallback) {
    const source = getFs(this.SourceFs);
    const target = getFs(this.TargetFs);

    await progress(10, { phase: 'copying', message: this.OriginalName });
    await source.copy(this.Path, this.Path, target);
    await source.rm(this.Path);
    await progress(100, { phase: 'done' });

    return { key: this.Path };
  }
}

interface MediaUploaderOptions {
  targetFs: string;
}

@Injectable()
@NewInstance()
export class MediaUploader extends FormFileUploader {
  constructor(public Options: MediaUploaderOptions) {
    super();
  }

  public async upload(file: IUploadedFile): Promise<IUploadedFile<{ jobId?: string }>> {
    if (!file.Provider) {
      throw new Error(`No source filesystem for ${file.BaseName}`);
    }

    const jobId = await MediaImportJob.emit({
      SourceFs: file.Provider.Name,
      TargetFs: this.Options.targetFs,
      Path: file.BaseName,
      OriginalName: file.Name,
      RetryCount: 3,
    });

    return { ...file, Provider: null, Data: { jobId } };
  }
}

@BasePath('media')
export class MediaController extends BaseController {
  @Post()
  public async upload(@File({ uploader: { service: MediaUploader, options: { targetFs: 'media-s3' } } }) media: IUploadedFile<{ jobId?: string }>) {
    return new Ok({ key: media.BaseName, jobId: media.Data?.jobId });
  }
}

// in the worker process
export async function startMediaWorker() {
  const queue = await DI.resolve(QueueService);
  await queue.consume(MediaImportJob);
}
```

Route the job with `queue.routing.MediaImportJob`; see [Upload job and worker](02-upload-job-and-worker.md#configuration).

## Important behaviour

- `upload()` runs for every file of the field in parallel (`Promise.allSettled`). Any rejection fails the whole field with `IOFail`.
- Whatever `upload()` returns replaces the file the controller gets; return `Provider: null` when the file is not readable yet.
- Do not redeclare `Log` in a subclass: `@Logger('http')` defines it on the `HttpLazyFileUploader` prototype as a non-configurable getter.
- A uploader with `@NewInstance()` is built on every request. Keep its constructor cheap.

## Best practices

- Give a custom job `@NewInstance()`, so concurrent deliveries in one worker do not share one hydrated instance.
- Set `RetryCount` on jobs that copy over the network; the shipped `LazyUploadJob` has none.
- Name custom jobs after what they do (`MediaImportJob`): the class name is the routing key and the `JobModel.Name`.

## Related

- [Lazy file upload](01-lazy-file-upload.md): the shipped uploader and its options.
- [Upload job and worker](02-upload-job-and-worker.md): routing and running the consumer.
- [`@spinajs/http`](../http/README.md): `FormFileUploader`, `IUploadOptions`, `ImmediateFileUploader`.
- [`@spinajs/queue`](../queue/README.md): `QueueJob`, `@Job()`, `QueueService.consume()`.
- [`@spinajs/di`](../di/README.md): `@Injectable()`, `@NewInstance()`, `DI.register().as()`.
