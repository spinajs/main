# Uploads and routes

`AuthzUploadMiddleware` refuses an upload with 403 before the file is copied. `fromFsPath` lets `@Access` on a route check a file named by a url parameter.

## How it works

### `AuthzUploadMiddleware`

1. `@spinajs/http` calls `beforeUpload(file, options)` of each `FileUploadMiddleware` before the uploader copies the file.
2. The target filesystem is `file.Provider`, else `IUploadOptions.fs`, else `__file_upload_default_provider__` (`DEFAULT_UPLOAD_FS`).
3. With mode `off` the file passes. Otherwise the path is `file.BaseName` normalised against the provider's base path; an empty name is an `InvalidArgument`.
4. `fs:write` is checked on the `file` ref in the filesystem's domain: `enforce` throws `AccessDenied` (403) and the temp file is never copied; `audit` warns.

### `fromFsPath`

`fromFsPath(fsName, param, container?)` returns a `ResourceExtractor` for the `@Access` decorator of `@spinajs/authz-http`: the `file` ref of the url parameter `param`, the `fs` ref for the root. The path is normalised with the `BasePath` of the published provider, so the ref is the one `AuthzFsMiddleware` checks for the same path.

- An Express 5 wildcard (`*path`) arrives as an array of segments; they are joined with `/`.
- A missing parameter, a refused segment (`..`, an empty one, one containing `/`) or a refused path is an `InvalidArgument` (400).

## Configuration

Add the middleware to `http.upload.middlewares` (keep the default `FileInfoMiddleware`), or to a route's `middlewares` after a transformer that renames the file.

```ts
{
  http: {
    upload: { middlewares: ['FileInfoMiddleware', 'AuthzUploadMiddleware'] },
  },
}
```

## Important behaviour

- `AuthzFsMiddleware` checks the copy again, but the uploader turns that denial into a 500. The upload middleware exists to give the 403.
- Keep the default upload filesystem `off`: it is a temp location, not a user's file space.
- Uploads that call `fs.upload(..., { exclusive: true })` directly, such as `ConfigFileUploads` of `@spinajs/configuration-http`, do not pass through `AuthzUploadMiddleware`. `AuthzFsMiddleware` checks them as `fs:write` on the stored name; see [File uploads](../configuration-http/05-file-uploads.md).
- In `@Access` use `subject: 'load'` so a relation grant answers definitely, and the filesystem's `domain` when it is not `root`.

## Examples

### Check a download route by path

```ts sample
import { fromFsPath } from '@spinajs/authz-fs';

export const invoicePath = fromFsPath('invoices', 'path');

// The resource of an @Access on a route such as GET /invoices/*path
export function refOfRequest() {
  return invoicePath({ params: { path: ['2026', 'march.pdf'] } });
}
```

## Related

- [Checks on file actions](02-checks-on-file-actions.md)
- [Upload middlewares and uploaders](../http/09-upload-middlewares-and-uploaders.md)
- [File uploads](../http/08-file-uploads.md)
