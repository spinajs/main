# `@spinajs/http-lazy-file-uploader`

A `FormFileUploader` for `@spinajs/http` routes that answers the request first and copies the uploaded file to its target filesystem later, in a queue job. Use it when the copy is slow, eg. to S3, and must not hold the HTTP request.

It does **not** run the copy in the web process: a queue consumer must process `LazyUploadJob`. It does **not** return the job id, and the file is not in the target filesystem when the controller runs.

## Install

```sh
npm install @spinajs/http-lazy-file-uploader
```

The package needs a configured `@spinajs/queue` connection and `@spinajs/fs` providers for the source and the target filesystem.

## Features

| Feature | What it does |
| --- | --- |
| [Lazy file upload](01-lazy-file-upload.md) | `HttpLazyFileUploader` on a `@File()` route: enqueues the copy and returns the file at once. |
| [Upload job and worker](02-upload-job-and-worker.md) | `LazyUploadJob`, its queue routing, and the process that consumes it (`fs-lazy:process`). |
| [Custom uploaders and jobs](03-custom-uploaders-and-jobs.md) | Extension points: subclassing and replacing the uploader in DI, your own uploader and job. |

## Quick start

```ts sample
import { BaseController, BasePath, File, IUploadedFile, Ok, Post } from '@spinajs/http';
import { HttpLazyFileUploader } from '@spinajs/http-lazy-file-uploader';

@BasePath('invoices')
export class InvoiceController extends BaseController {
  @Post()
  public async upload(
    @File({ uploader: { service: HttpLazyFileUploader, options: { fs: 'invoices-s3' } } })
    invoice: IUploadedFile,
  ) {
    // The copy to `invoices-s3` is queued; store the name to find the file later.
    return new Ok({ stored: invoice.BaseName, originalName: invoice.Name });
  }
}
```

## Related packages

- [`@spinajs/http`](../http/README.md): owns `@File()`, `IUploadOptions.uploader` and the `FormFileUploader` contract this package implements.
- [`@spinajs/queue`](../queue/README.md): carries `LazyUploadJob` from the web process to the worker and tracks it in `JobModel`.
- [`@spinajs/fs`](../fs/README.md): the source and target filesystems, looked up by name with `getFs()`.
- [`@spinajs/cli`](../cli/README.md): runs the `fs-lazy:process` command.
