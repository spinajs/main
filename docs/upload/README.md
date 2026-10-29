# `@spinajs/upload`

Resumable, verified chunked uploads. A client creates an upload session, sends the file as numbered parts with a SHA-256 for each part, resumes from the stored parts after a failure, and completes the session. The package then assembles the parts into one file, hashes every byte again, and removes what is left over.

It keeps sessions in three tables, writes through any two [`@spinajs/fs`](../fs/README.md) providers, and ships an abstract `UploadController` that your app subclasses. It does **not** mount any route by itself. It has **no** download routes, virus scanning, tus protocol or presigned direct-to-S3 part uploads.

## Install

```sh
npm install @spinajs/upload
# the HTTP routes (UploadController)
npm install @spinajs/http @spinajs/validation
# the scheduled sweeper
npm install @spinajs/scheduler
```

- `@spinajs/http`, `@spinajs/validation` and `@spinajs/scheduler` are optional peer dependencies, each pinned to one exact version. Install `@spinajs/upload` and its `@spinajs/http` together, at the same version as your other `@spinajs/*` packages.
- The main entry has no HTTP code, so a worker that only runs the sweeper does not load Express.

| Import path | What it holds |
| --- | --- |
| `@spinajs/upload` | `UploadService`, `UploadStorage`, `UploadStore`, `ContentTypeCheck`, `ContentDetector`, `UploadSweeper`, models, migration, events, errors, config schema |
| `@spinajs/upload/http` | `UploadController`, `CreateUploadDto`, `CompleteUploadDto`, `uploadErrorResponse`, `hookRefusalResponse`, `UPLOAD_INTERNAL_ERROR` |
| `@spinajs/upload/scheduler` | `UploadSweepTask`, the `upload.sweep` schedule |

## Features

| Feature | What it does |
| --- | --- |
| [Wire protocol](01-protocol.md) | The six routes, their headers and bodies, the resume state, every error code with its status |
| [Configuration](02-configuration.md) | Every `upload.*` key, the shipped `db` and `queue` config, the providers you define |
| [Integrity](03-integrity.md) | Part and file SHA-256, `Content-Digest`, re-verification at assembly, blob tracking |
| [Extending the controller](04-extending-the-controller.md) | Subclass `UploadController`: `authorize`, owners, metadata, limits, types, providers, completion handlers, access control |
| [Service and hooks](05-service-and-hooks.md) | `UploadService` without HTTP, and the `upload.create` and `upload.complete` hook actions |
| [Limits](06-limits.md) | Size, part and session limits; `http.bodyLimits`, `http.throttle` and Node timeouts; how refused parts are drained or closed |
| [Storage providers](07-storage-providers.md) | The temp and files providers, object keys, exclusive writes, S3 notes |
| [Content checks and detectors](08-content-checks-and-detectors.md) | How the declared and detected MIME types are checked; writing a `ContentDetector` |
| [Events](09-events.md) | The twelve upload events, black-hole routing, at-least-once final events |
| [Logging](10-logging.md) | The `upload` logger: levels, fields, what is never logged |
| [Sweeper](11-sweeper.md) | `UploadSweeper`: expiry, stale claims, leftovers, re-emitted events, retention; the scheduler task and `upload:sweep` |
| [Database](12-database.md) | The `upload` connection alias, the migration, the three tables and their models |

## Quick start

Define the two providers and run the migration, in your app's config:

```ts
// config/upload.ts in your app
export default {
  fs: {
    providers: [
      { service: 'fsNative', name: 'upload-temp', basePath: './data/upload-parts' },
      { service: 'fsNative', name: 'upload-files', basePath: './data/files' },
    ],
  },
  db: {
    // the upload tables go to the connection db.Aliases.upload names: 'default' unless you change it
    Connections: [{ Driver: 'orm-driver-sqlite', Filename: './data/app.sqlite', Name: 'main', Migration: { OnStartup: true } }],
    DefaultConnection: 'main',
  },
};
```

Then subclass the controller in a directory listed in `system.dirs.controllers`:

```ts sample
import { AuthenticationFailed, Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { BasePath } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { UploadSession } from '@spinajs/upload';
import { UploadController } from '@spinajs/upload/http';
import type { UploadAction } from '@spinajs/upload/http';

/** Your authentication layer: the signed-in user's id, if any. */
declare function signedInUserId(req: Request): string | undefined;

/** Your permission check. */
declare function mayUploadDocuments(userId: string, action: UploadAction): boolean;

/** POST /documents/uploads, then PUT /documents/uploads/:upload/parts/:part, then POST .../complete */
@BasePath('documents/uploads')
export class DocumentUploadsController extends UploadController {
  protected async ownerOf(req: Request): Promise<string | null> {
    const user = signedInUserId(req);
    if (user === undefined) throw new AuthenticationFailed('sign in to upload documents');
    return user;
  }

  protected async authorize(action: UploadAction, req: Request, session?: UploadSession): Promise<void> {
    const user = await this.ownerOf(req);
    if (user === null || !mayUploadDocuments(user, action)) throw new Forbidden(`${action} is not allowed`);
    if (session && session.owner !== user) throw new ResourceNotFound('no such upload');
  }
}
```

The client flow is on [Wire protocol](01-protocol.md#client-flow). Run the [sweeper](11-sweeper.md) on a schedule, or expired sessions and their parts stay on disk.

## Related packages

- [`@spinajs/fs`](../fs/README.md): the providers every part and file is written through; `DigestStream`, `ByteLimitStream` and exclusive writes.
- [`@spinajs/fs-s3`](../fs-s3/README.md): an S3 provider for the files, with exclusive writes and prefix removal.
- [`@spinajs/http`](../http/README.md): `@RequestStream()` and `@ContentDigest()`, the raw-body route arguments of the part route.
- [`@spinajs/http-swagger`](../http-swagger/README.md): documents the part route as an octet-stream body with a `content-digest` header.
- [`@spinajs/orm`](../orm/README.md): the `upload` connection alias, the migration and the models.
- [`@spinajs/queue`](../queue/README.md): delivers the upload events.
- [`@spinajs/hooks`](../hooks/README.md): the `upload.create` and `upload.complete` actions.
- [`@spinajs/scheduler`](../../packages/scheduler/README.md): runs the `upload.sweep` task on one node of a cluster.
- [`@spinajs/validation`](../validation/README.md): validates the create and complete bodies.
