# Service and hooks

`UploadService` holds every upload operation without HTTP: the controller is a thin layer over it. Use it directly from your own routes, a socket handler or a job. Two hook actions, `upload.create` and `upload.complete`, let a package or an app add rules that apply whichever caller runs the operation.

## How it works

1. The caller loads the session with `get(id, owner)`: a missing session, or one whose `owner` differs, throws `UploadError('upload.not_found')`. `owner: null` leaves the lookup unscoped.
2. The caller authorizes the session itself; the service does not know your users.
3. It calls the operation. Every refusal is an `UploadError` with a stable `code` and the HTTP `status` a controller answers. `UploadError` is a `CodedHttpException` (`@spinajs/exceptions`): thrown from your own route, the `@spinajs/http` error map answers it with that status and the same `{ code, message, details? }` body as `UploadController`.

| Method | Returns | What it does |
| --- | --- | --- |
| `create(input: CreateUploadInput)` | `Promise<UploadStateView>` | Checks the input against the effective limits, maps the name to its MIME type, runs the `upload.create` hook action, inserts the session and emits `UploadCreated`. |
| `get(id, owner?)` | `Promise<UploadSession>` | The session row, owner-scoped when `owner` is a string. |
| `state(session)` | `Promise<UploadStateView>` | The resume state, read fresh from the database. |
| `putPart(session, part, body, digest, length, options?)` | `Promise<PartStoredView>` | Stores one part ([Integrity](03-integrity.md#a-part-uploadserviceputpart)). `digest` is the raw 32-byte SHA-256 or `undefined`, `length` the declared byte count or `undefined`, `options.allowedTypes` defaults to `'*'`. |
| `complete(session, input?, options?)` | `Promise<UploadStateView>` | Assembles and verifies the file, then runs the `upload.complete` hook action and `options.onCompleted` while `handled_at` is null. `input.sha256` is the file hash when create had none; `options.fileDir` defaults to `<upload.fs.prefix>/files`. |
| `abort(session)` | `Promise<boolean>` | `open` → `aborted`; `false` when it was already aborted. Throws `upload.assembling` while the session assembles, and `upload.not_open` when it is completed, failed or expired. Removes the parts and emits `UploadAborted`. |
| `expire(session)` | `Promise<boolean>` | `open` → `expired` once `expiresAt` passed; `false` when it was not due. Emits `UploadExpired`; the sweeper removes the parts. |

`CreateUploadInput` is `{ name, size, sha256?, partSize?, metadata?, owner?, limits?, allowedTypes?, allowUnknownType?, fs? }`; `metadata` and the last five are what the controller fills from `metadataFor`, `ownerOf`, `limitsFor`, `allowedTypes`, `allowUnknownType` and `fsFor`.

### Hook actions

| Action | Input | Mutable keys | Refusable | Runs |
| --- | --- | --- | --- | --- |
| `upload.create` | `UploadCreateHookInput`: `name`, `size`, `sha256`, `partSize`, `partCount`, `declaredMime`, `owner`, `metadata` | `metadata` | yes | In `create()`, after the limits and the owner's quick open-session count, before the insert. Output: the `UploadStateView`. |
| `upload.complete` | `UploadCompleteHookInput`: `upload` (the completed view), `owner`, `metadata`, `filesFs`, `fileKey` | none | yes | In `complete()`, once per completed session while `handled_at` is null, around `onCompleted`. |

- A `before` hook that calls `ctx.refuse(code)` stops the operation with `ActionRefused`. The controller answers it `403 { code, message }`.
- A refused or failing `upload.complete` before hook leaves `handled_at` null, so the next complete runs the hooks and `onCompleted` again.
- An error in an `after` hook is only logged by `@spinajs/hooks`. Work that must be retried belongs in a `before` hook or in `onCompleted`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UploadService` | `UploadService`, `@Singleton()` | `UploadService` | your subclass | Subclass and `DI.register(MyService).as(UploadService)` before anything resolves it. Prefer a hook for new rules: the methods are long and their private steps keep the invariants. |
| `upload.create` hook action | `ActionHook` list (`@spinajs/hooks`), `@Injectable(ActionHook)` | none | your hooks | Write an `ActionHook<'upload.create'>`. The action is declared by augmenting `HookActions` in `@spinajs/upload`. |
| `upload.complete` hook action | as above | none | your hooks | Write an `ActionHook<'upload.complete'>`. |
| `UploadStore` | `UploadStore`, `@Singleton()` | `UploadStore` | none | Every SQL statement on the upload tables. Not meant to be replaced; use it read-only for reports. |

### `upload.create` hook: custom implementation

Refuse uploads that would take a project over its storage quota, and stamp the check time on the session:

```ts sample
import { Injectable } from '@spinajs/di';
import { ActionHook } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';
import '@spinajs/upload';

@Injectable()
export class ProjectQuotas {
  private readonly freeBytes = new Map<string, number>([['p-1001', 50 * 1024 ** 3]]);

  public async free(projectId: string): Promise<number> {
    return this.freeBytes.get(projectId) ?? 0;
  }
}

@Injectable(ActionHook)
export class ProjectQuotaHook extends ActionHook<'upload.create'> {
  public readonly actions = ['upload.create'] as const;

  protected Quotas = new ProjectQuotas();

  public async before(ctx: BeforeContext<'upload.create'>): Promise<void> {
    const projectId = ctx.input.metadata.projectId;
    if (typeof projectId !== 'string') return;
    if (ctx.input.size > (await this.Quotas.free(projectId))) ctx.refuse('project.quota_exceeded', `project ${projectId} has no room for ${ctx.input.size} bytes`);
    ctx.input.metadata = { ...ctx.input.metadata, quotaCheckedAt: new Date().toISOString() };
  }
}
```

The client gets `403 { "code": "project.quota_exceeded", "message": "..." }`. Import the module at boot so the decorator registers the hook. A real app injects `ProjectQuotas` with `@Autoinject()`.

## Important behaviour

- **No transaction around the calls.** `create`, `putPart`, `complete` and `abort` run their own transactions and emit events after the commit. Called inside your transaction, the events go out before your commit.
- **`create` checks the owner's cap twice.** A quick count refuses a full owner before the hooks run; the insert counts again under a lock on the owner's open rows. See [Limits](06-limits.md#important-behaviour) for the one race that remains.
- **The locked insert retries once.** A lock or serialization conflict (MySQL `1213` or `1205`, SQLSTATE `40001` or `40P01`) repeats the transaction one time. Inside a caller's transaction it never retries: the caller owns the retry. A `1205` retry can double the worst-case create latency.
- **`putPart` leaves a refused body unread** when it refuses before reading. The caller must drain it or close the connection; the controller does both.
- **Every status change is conditional.** Two callers racing on one session cannot both win: the loser gets `upload.not_open`, `upload.assembling` or `false`. A caller that loses the claim on a session that is open again also gets `upload.assembling`: retry the complete.
- **`complete` is idempotent.** On a completed session it returns the view and only runs the handlers that have not succeeded.

## Best practices

- Pass the owner to `get()` whenever the caller acts for a user; `get(id)` alone ignores ownership.
- Use hook codes from your own namespace (`project.quota_exceeded`), so clients can tell them from `upload.*` codes.
- Keep `upload.create` hooks fast: they run inside the create request, before the session exists.
- Refuse from a hook with `ctx.refuse(code)`; the controller answers `403 { code, message }`. `UploadError` codes are fixed to the list in [Errors](01-protocol.md#errors).

## Examples

### Accept an upload over a WebSocket command

```ts sample
import { DI } from '@spinajs/di';
import { UploadService } from '@spinajs/upload';
import type { UploadStateView } from '@spinajs/upload';

export async function startReportUpload(userId: string, name: string, size: number, sha256: string): Promise<UploadStateView> {
  const uploads = await DI.resolve(UploadService);
  return uploads.create({ name, size, sha256, owner: userId, allowedTypes: ['text/csv'], metadata: { kind: 'monthly-report' } });
}

export async function finishReportUpload(userId: string, uploadId: string): Promise<UploadStateView> {
  const uploads = await DI.resolve(UploadService);
  const session = await uploads.get(uploadId, userId);
  return uploads.complete(session, {}, { fileDir: `reports/${userId}` });
}
```

## Related

- [Writing a hook](../hooks/01-writing-a-hook.md): order, mutable keys, refusal, timeouts.
- [Extending the controller](04-extending-the-controller.md): the controller's use of the service.
- [Events](09-events.md): what the service emits.
