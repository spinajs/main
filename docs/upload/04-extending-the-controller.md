# Extending the controller

`UploadController` is an abstract controller with the six [upload routes](01-protocol.md) and a set of protected methods for your domain rules. Subclass it once per place you accept uploads, give it a `@BasePath` and an `authorize()`, and put it in your controllers directory.

## How it works

1. Import the base from the HTTP subpath: `import { UploadController } from '@spinajs/upload/http'`. It needs `@spinajs/http` and `@spinajs/validation` installed.
2. The package lists no controllers directory, and the base lives outside any, so it is never mounted by itself. Your subclass is discovered like any controller: a file in a `system.dirs.controllers` directory, or a [registered controller](../http/03-controller-discovery.md).
3. `@BasePath` on the subclass gives it its own copy of the inherited routes, policies and error handlers. Path placeholders work: `@BasePath('projects/:project/uploads')` gives `req.params.project` to every route.
4. Per request, after the policies and the argument stage:
   - `create` calls `authorize('create', req)`, then collects `metadataFor`, `ownerOf`, `limitsFor`, `allowedTypes`, `allowUnknownType` and `fsFor`, and calls `UploadService.create()`;
   - every other route calls `sessionFor(action, id, req)`: it loads the session with the owner from `ownerOf(req)` (a missing or foreign session answers `404` `upload.not_found`), then calls `authorize(action, req, session)`;
   - `putPart` passes `allowedTypes(req)` to the content check of part 1; `complete` passes `fileDir(session)` and `onCompleted`; `abort` runs `onAborted` once, for the request that aborted.
5. Errors: the base maps `UploadError` to `{ code, message, details? }` with the error's status, and a refusing hook (`ActionRefused`) to `403 { code, message }`. A third, last class-level handler answers every error the framework would answer as a generic `500` with `500 { code: 'upload.internal', message: 'Internal error' }` (`UPLOAD_INTERNAL_ERROR`) and logs the original with the `uploadId`. An error with a status of its own, such as `Forbidden` or `ResourceDuplicated` (`409`), keeps the [error map](../http/11-error-handling.md) body. Codes are listed in [Errors](01-protocol.md#errors).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@BasePath(path)` | your subclass | the base path; `:placeholders` allowed | Required. Mounts the inherited routes under `path`. |
| `@Access(permission, opts?)` (`@spinajs/authz-http`) | your subclass, or a re-declared route method | see [Protecting routes](../authz-http/01-protecting-routes.md) | Gates every route (class) or one route (method) before the action. The base declares no policy group, so yours is the only one. |
| `@Policy(policy)` | your subclass or a route method | a `BasePolicy` | An extra policy group. Groups at one place are alternatives (OR); see [Important behaviour](#important-behaviour). |
| `@OnError(error, handler)` | your subclass | an error class and a handler | Runs before the base's three handlers, so it can answer `UploadError`, `ActionRefused` or an internal error your way. |

## Overridable methods

| Method | Default | Override to |
| --- | --- | --- |
| `authorize(action, req, session?)` | abstract: a subclass without it does not compile | Refuse an action: throw `Forbidden`, `AuthenticationFailed` or `ResourceNotFound`. `action` is `'create'`, `'read'`, `'putPart'`, `'complete'` or `'abort'`; `session` is absent for `'create'`. |
| `ownerOf(req)` | `null`: unscoped, with no owner filter and no open-session cap | Return the user's or tenant's id. It is stored on new sessions, scopes every lookup, and is what `maxOpenSessionsPerOwner` counts. **An app with users must override it, and throw when the request has no principal.** Return `null` on purpose only in a single-tenant app. |
| `metadataFor(req, dto)` | the client's `dto.metadata`, or `{}` | Store your own data with the session, for example `{ projectId }` from the path. It reaches every event: no secrets. |
| `limitsFor(req)` | `{}` | Tighten [limits](06-limits.md) per request. It can only tighten the configured ones. A duration such as `sessionTtl` must be greater than zero: `'0s'` throws `InvalidOption`, answered `500 upload.internal`. |
| `allowedTypes(req)` | `'*'` | Return the accepted MIME types (`readonly string[]`). Checked against the name at create (`415`) and the content of part 1 (`415`). |
| `allowUnknownType(req)` | `false` | Return `true` to accept a name whose extension maps to no MIME type. |
| `fsFor(req, dto)` | `{ temp: upload.fs.temp, files: upload.fs.files }` | Pick the providers per session, for example a bucket per tenant. They are fixed at create. |
| `fileDir(session)` | `` `${upload.fs.prefix}/files` `` | Put the merged file elsewhere on the files provider. The key is `<fileDir>/<uuid><ext>`, so keys stay unique. Synchronous. A directory with a `..` segment is refused with `InvalidOption`, answered `500 upload.internal`. |
| `onCompleted(session, req)` | does nothing | Your domain work once the file is verified: attach it to a record, start processing. Runs until it succeeds: a rejection answers `500` `upload.internal`, or the error's mapped status, and runs again on the next complete. |
| `onAborted(session, req)` | does nothing | Clean up your own records. Runs once, for the `DELETE` that aborted the session; a failure is logged at `error` and the `DELETE` still answers `204`. |
| `sessionFor(action, id, req)` | owner-scoped lookup, then `authorize` | Call it from your own routes on the same controller to load a session the same way. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UploadController` | abstract class; not registered, never mounted | none | your subclasses | Subclass with `@BasePath` and `authorize()`; override the methods above. |
| `UploadService` | `UploadService`, `@Singleton()`, injected as `this.Uploads` | `UploadService` | your subclass | `DI.register(MyService).as(UploadService)` before the controllers resolve. See [Service and hooks](05-service-and-hooks.md). |
| Error answers | `@OnError(UploadError, uploadErrorResponse)`, `@OnError(ActionRefused, hookRefusalResponse)` and a last `@OnError(Error, ...)` on the base | `{ code, message, details? }`, `403 { code, message }` and `500 upload.internal` | your own `@OnError` | A class-level `@OnError` on the subclass runs first; return a `Response` to answer differently. |

### `UploadController`: custom implementation

Accept drawings and PDFs into a project, scope uploads to the signed-in user, store the project id with each session, and attach the verified file to the project:

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthenticationFailed, Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { BasePath } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { AllowedTypes, UploadLimits, UploadSession } from '@spinajs/upload';
import { UploadController } from '@spinajs/upload/http';
import type { CreateUploadDto, UploadAction } from '@spinajs/upload/http';

/** Your authentication layer: the signed-in user's id, if any. */
declare function signedInUserId(req: Request): string | undefined;

/** Your project store. */
@Injectable()
export class Projects {
  private readonly members = new Map<string, Set<string>>();

  public async isMember(projectId: string, userId: string): Promise<boolean> {
    return this.members.get(projectId)?.has(userId) ?? false;
  }

  public async attachFile(projectId: string, file: { key: string; sha256: string; name: string }): Promise<void> {
    console.log(`project ${projectId}: ${file.name} stored at ${file.key} (${file.sha256})`);
  }
}

const projectOf = (req: Request): string => String(req.params.project ?? '');

// POST /projects/:project/uploads, PUT /projects/:project/uploads/:upload/parts/:part, ...
@BasePath('projects/:project/uploads')
export class ProjectUploadsController extends UploadController {
  protected Projects = new Projects();

  protected async ownerOf(req: Request): Promise<string | null> {
    const user = signedInUserId(req);
    if (user === undefined) throw new AuthenticationFailed('sign in to upload');
    return user;
  }

  protected async authorize(_action: UploadAction, req: Request, session?: UploadSession): Promise<void> {
    const user = await this.ownerOf(req);
    if (!(await this.Projects.isMember(projectOf(req), user!))) throw new Forbidden('not a member of this project');
    // in depth: the scoped lookup already matched the owner
    if (session && session.owner !== user) throw new ResourceNotFound('no such upload');
    // a session created under another project is not found under this one
    if (session && session.metadata.projectId !== projectOf(req)) throw new ResourceNotFound('no such upload in this project');
  }

  protected async metadataFor(req: Request, _dto: CreateUploadDto): Promise<Record<string, unknown>> {
    return { projectId: projectOf(req) };
  }

  protected async limitsFor(_req: Request): Promise<Partial<UploadLimits>> {
    return { maxFileSize: 2 * 1024 ** 3, sessionTtl: '6h' };
  }

  protected async allowedTypes(_req: Request): Promise<AllowedTypes> {
    return ['application/pdf', 'image/vnd.dwg', 'image/vnd.dxf', 'image/png', 'image/jpeg', 'image/tiff'];
  }

  protected async onCompleted(session: UploadSession, _req: Request): Promise<unknown> {
    await this.Projects.attachFile(String(session.metadata.projectId), { key: session.file_key!, sha256: session.sha256!, name: session.name });
    return undefined;
  }
}
```

`image/vnd.dxf` content has no built-in detector: register one, see [Content checks and detectors](08-content-checks-and-detectors.md#contentdetector-custom-implementation). A real app injects `Projects` with `@Autoinject()`; the sample creates it inline to stay self-contained.

## Access control

Put the permission check on the subclass with `@Access` from `@spinajs/authz-http`:

```ts
@Access('project:upload', { resource: fromParam('project', 'project') })
@BasePath('projects/:project/uploads')
export class ProjectUploadsController extends UploadController {
  // plus ownerOf(), as in the sample above: @Access checks only the project in the path

  protected async authorize(_action: UploadAction, req: Request, session?: UploadSession): Promise<void> {
    if (session && session.metadata.projectId !== projectOf(req)) throw new ResourceNotFound('no such upload in this project');
  }
}
```

- The base declares no policy group, so the subclass's `@Access` group gates every route. It runs before the session lookup and before `authorize`.
- `@Access` does not replace `ownerOf()` or the project check in `authorize()`. It tests the project in the path, not the session id, so without them a holder of `project:upload` on project A reaches any session through `/projects/A/uploads/<id>`.
- To narrow one route, re-declare the method with its own decorator and call `super`. The route keeps its path and its place in the route order:

```ts
@Access('project:cancel-upload', { resource: fromParam('project', 'project') })
public async abort(@Param() upload: string, @Req() req: Request) {
  return super.abort(upload, req);
}
```

## Safe mounting checklist

1. **Mount a subclass, never the base.** Put the subclass in your controllers directory with its own `@BasePath`. Never put `UploadController`, or a file that re-exports it, in a scanned directory.
2. **`authorize` handles every action.** `'read'` covers both `GET` and `HEAD`; `'create'` gets no session. Compare the session's `owner` and `metadata` with the principal, and throw `Forbidden` or `ResourceNotFound` to refuse. Comparing `session.owner` adds a second check behind the owner-scoped lookup.
3. **Scope by owner.** The default `ownerOf()` returns `null`, which turns off owner scoping and the open-session cap. Override it, and when a request has no principal throw (`Forbidden`, `AuthenticationFailed`) instead of returning `null`: a `null` there fails open. Return `null` on purpose only in a single-tenant app where every caller may see every session.
4. **Refuse anonymous requests in a policy.** Put `@Access` (or a `@Policy`) on the subclass, so an unauthenticated request is refused before body validation and before the session lookup. Policy refusals of a part are drained like any other refusal.
5. **Derive metadata on the server.** `metadataFor()` should build or whitelist the metadata. The client's `metadata` is untrusted, has no bound of its own (only `http.bodyLimits` caps the request body), and reaches every event consumer.
6. **Keep CSRF on.** Leave `http.csrf` enabled, never put `@CsrfExempt()` on upload routes, add your SPA's origin to `http.csrf.allowedOrigins`, and list your session cookie in `http.csrf.ambientCookies` when you authenticate with cookies.
7. **CORS for browser clients.** Expose `Location`, `Upload-Offset`, `Upload-Length` and `Upload-Part-Size` in `http.cors.exposedHeaders`, and allow the `content-digest` request header in `http.cors.allowedHeaders` when you set that list. `PUT`, `DELETE` and `HEAD` are in the preflight's allowed methods already.
8. **Expect `upload.internal` for unmapped errors.** A failing `onCompleted` or a server misconfiguration answers `500 { code: 'upload.internal' }` in every environment, with no stack or error fields; the original is logged with the `uploadId`. Your `http.errors.handlers` do not see these `500`s. To answer them yourself, add a class-level `@OnError(Error, handler)` on the subclass: it runs before the base's `UploadError` and `ActionRefused` handlers, so return nothing unless `answeredAsServerError(err)` (from `@spinajs/http`) is true.
9. **Run in production mode.** Set `APP_ENV` to `production` (or `prod`); when `APP_ENV` is unset, `NODE_ENV` decides. Mapped errors such as `Forbidden`, `ResourceNotFound` and `ValidationFailed` keep the framework body, which carries the stack outside production and the error's enumerable fields in every environment. Keep secrets out of the properties of errors your `authorize`, `ownerOf` and hooks throw.
10. **Expect resets from server-level refusals.** Throttling, the CSRF guard, `http.bodyLimits` and unmatched routes answer before routing, without draining the body, so a client may see a reset. Keep the throttle limit on the part path generous and any body limit well above `maxPartSize`, and have clients treat a reset `PUT` as retryable and check the state with `HEAD` first.
11. **Size the request timeout.** Set `server.requestTimeout` so a `maxPartSize` part arrives within it from the slowest client you support. Never set it to `0`: that turns the timeout off, and a drained refusal could then hold a connection forever.
12. **Clients send exact parts.** The exact `Content-Length`, `Content-Type: application/octet-stream` (or none), and `Content-Digest: sha-256=:…:`.
13. **When you re-declare routes:**
    - to add error handling to `putPart`, use a class-level `@OnError`: route-level handlers run before the base's drain step, and one that answers skips it;
    - new routes for one path declare `HEAD` before `GET`;
    - reuse `sessionFor()` to load sessions;
    - never wrap service calls in a transaction;
    - `Location` is built from `req.originalUrl`, so behind a proxy that strips a path prefix it lacks that prefix.

## Important behaviour

- **Fail closed.** `authorize` is abstract. Any throw refuses; returning means allowed. For every route but `create` it runs after the owner-scoped lookup, so it sees the session row as loaded before the operation.
- **Body validation runs before `authorize`.** `@Body` DTOs are validated in the arguments stage, before the action. A caller that `authorize` would refuse gets `400` (the framework's `ValidationFailed` body), not `403`, when its create or complete body is invalid. Only a policy (`@Access`, `@Policy`) refuses before validation.
- **Validation coerces types.** `"10"` becomes `10`: the DTO schema ids start with `upload.`, which is not a strict prefix. Set `validation.strict.idPrefixes` to `['authn.', 'authz.', 'upload.']` (the default is `['authn.', 'authz.']`) to turn coercion off.
- **Policy groups are OR'd.** A class-level `@Policy(X)` next to `@Access(...)` adds a second group, and a request passing either group passes. Put extra conditions inside `@Access(..., { also: [X] })` to AND them.
- **`@Access` on a subclass replaces an inherited `@Access`** of the same place; a plain `@Policy` adds a group.
- **HEAD before GET.** The base declares `HEAD :upload` before `GET :upload`; a re-declared method keeps its place. If your subclass adds its own `GET` and `HEAD` for one path, declare `HEAD` first, or `GET` answers `HEAD` requests.
- **Never wrap create or complete in a transaction.** The service commits its own transactions and emits its events after them; inside an outer transaction the events go out before the data they report is committed.
- **`onCompleted` is at least once.** It runs while `handled_at` is null and sets it after success. A crash between your work and that update runs it again: make it idempotent, keyed by `session.id`.
- **`onAborted` gets the aborted row.** It is loaded again after the abort, without owner scoping.
- **No CSRF exemption.** Browser writes need their origin in `http.csrf.allowedOrigins`. Every unsafe upload route (create, `PUT` part, `POST` complete, `DELETE`) from a foreign `Origin` answers `403` with `E_CSRF_ORIGIN`.
- **`upload.internal` hides the cause.** It covers only errors the framework would answer as a generic `500`. A mapped error, such as `ResourceDuplicated` (`409`), keeps the framework body. A subclass's own class-level `@OnError` runs first.
- **Server misconfiguration is a `500`.** A `fileDir` with a `..` segment, or a zero duration from `limitsFor`, throws `InvalidOption`, answered `500 upload.internal`, not `400`.
- **Metadata has no size bound.** The service checks only that it is an object; `http.bodyLimits` caps the request body.
- **Part drain falls back to `upload.limits.maxPartSize`.** The expected size is known only after `authorize` passed and the part number is in range. A part refused earlier, or by `authorize` itself, or with an out-of-range part number, is drained up to the configured maximum part size. A body declared above the bound, or with no `Content-Length`, closes the connection.

## Best practices

- Override `ownerOf` in any app with users, and throw there when the request has no principal. With the default `null`, every caller can read and complete every session it can guess the id of.
- Derive metadata on the server (`metadataFor`) instead of trusting `dto.metadata`: it reaches every event consumer.
- Keep `onCompleted` short and idempotent. Heavy processing belongs in a job started from it or from the `UploadCompleted` event.
- Return `allowedTypes` for every controller that feeds a parser; `'*'` accepts any detected type.

## Patterns and antipatterns

```ts
// Don't: a plain class policy is an alternative to @Access, so a request passing AdminIp skips the permission check
@Policy(AdminIp)
@Access('project:upload')
@BasePath('projects/:project/uploads')
export class ProjectUploadsController extends UploadController {
  /* authorize, ownerOf */
}

// Do: AND the extra policy into the @Access group
@Access('project:upload', { also: [AdminIp] })
@BasePath('projects/:project/uploads')
export class ProjectUploadsController extends UploadController {
  /* authorize, ownerOf */
}
```

```ts
// Don't: an outer transaction lets UploadCreated out before the session row is committed
await driver.transaction(() => this.Uploads.create(input));

// Do: call the service directly, and keep your own writes in onCompleted or a hook
await this.Uploads.create(input);
```

## Related

- [Wire protocol](01-protocol.md): the routes these methods sit behind.
- [Service and hooks](05-service-and-hooks.md): the same rules without a controller.
- [Controllers and routing](../http/02-controllers-and-routing.md): `@BasePath`, inheritance and route order.
- [Policies](../http/13-policies.md): AND groups and OR alternatives.
