# `@spinajs/upload`

Resumable, verified chunked uploads for SpinaJS: sessions, numbered parts with a SHA-256 each, resume, assembly with re-verification, content type checks, events and a sweeper.

```sh
npm install @spinajs/upload
npm install @spinajs/http @spinajs/validation   # for UploadController (@spinajs/upload/http)
npm install @spinajs/scheduler                  # for the scheduled sweeper (@spinajs/upload/scheduler)
```

`@spinajs/upload` pins its optional peers `@spinajs/http`, `@spinajs/scheduler` and `@spinajs/validation` to one exact version: install and upgrade them together with it, at the version of your other `@spinajs/*` packages.

Subclass `UploadController` from `@spinajs/upload/http` with your own `@BasePath`, `ownerOf()` and `authorize()`, define the `upload-temp` and `upload-files` providers in `fs.providers`, and run the `Upload_2026_10_23_00_00_00` migration.

```ts
@BasePath('documents/uploads')
export class DocumentUploadsController extends UploadController {
  protected async ownerOf(req: Request): Promise<string | null> {
    const user = signedInUserId(req);
    if (user === undefined) throw new AuthenticationFailed('sign in to upload documents');
    return user;
  }

  protected async authorize(_action: UploadAction, req: Request, session?: UploadSession): Promise<void> {
    const user = await this.ownerOf(req);
    if (session && session.owner !== user) throw new ResourceNotFound('no such upload');
  }
}
```

The default `ownerOf()` returns `null`: no owner filter and no open-session cap. An app with users overrides it and throws when the request has no principal.

## Documentation

- [Package overview](../../docs/upload/README.md)
- [Wire protocol](../../docs/upload/01-protocol.md)
- [Extending the controller](../../docs/upload/04-extending-the-controller.md)
