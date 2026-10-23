# Events

Every stage of an upload emits a `@spinajs/queue` event: other services can index a finished file, notify a user or keep an audit trail without touching the upload code. By default every event goes to a black hole; route the ones you consume to a real connection.

## How it works

1. A service method commits its database change, then emits the event with `ev()`. A consumer never sees a state that was rolled back.
2. `ev()` looks up `queue.routing.<EventName>`. The package config routes all twelve events to the connection `upload-events`, a `BlackHoleQueueClient`, so nothing leaves the process.
3. **Stage events** are best effort: a failed emit is logged at `warn` and the request goes on.
4. **Final events** (`UploadCompleted`, `UploadFailed`, `UploadAborted`, `UploadExpired`) are delivered at least once:
   - the commit that makes a session final also records the event it owes (`final_event`);
   - after a successful emit, `final_event_at` is set;
   - the [sweeper](11-sweeper.md) emits every owed event again whose session last changed more than `upload.assembly.staleAfter` ago and still has no `final_event_at`. A session changes last when it becomes final.

| Event | Stage | Extra fields | Emitted by |
| --- | --- | --- | --- |
| `UploadCreated` | Session created | `PartSize`, `PartCount`, `DeclaredMime` (`string \| null`), `DeclaredSha256?`, `ExpiresAt` | `UploadService.create` |
| `UploadPartStored` | A part passed every check and was committed | `Part`, `PartSize`, `PartSha256`, `Offset`, `ReceivedParts`, `PartCount`, `Replaced` (a resend replaced a stored copy) | `putPart` |
| `UploadPartRejected` | A part was refused with an upload error; nothing was stored. An unexpected storage error emits none | `Part`, `Code` (the `upload.*` code) | `putPart` |
| `UploadContentChecked` | Part 1's content type was checked. A refusal is emitted at once; an accepted check only after the part is committed | `DeclaredMime`, `DetectedMime?`, `DetectorId?`, `Accepted` | `putPart` (part 1) |
| `UploadAssemblyStarted` | A complete took the assembly claim | `ClaimToken`, `PartCount` | `complete` |
| `UploadPartCorrupted` | Stored parts failed their hash at assembly; the session is `open` again | `Parts` (numbers) | `complete` |
| `UploadAssemblyReleased` | A claim was released after an error, or a stale one was taken over or released | `Reason`: `'error'` or `'stale'` | `complete`, the sweeper |
| `UploadCompleted` | **Final.** The file is verified and committed | `Sha256`, `Mime`, `FileKey`, `CompletedAt` | `complete`, the sweeper (again) |
| `UploadFailed` | **Final.** The merged file's hash or size did not match | `Code`, `Message` | `complete`, the sweeper (again) |
| `UploadAborted` | **Final.** The session was aborted | none | `abort`, the sweeper (again) |
| `UploadExpired` | **Final.** The session passed `expiresAt` unfinished | `ExpiresAt` | `UploadService.expire` (run by the sweeper), the sweeper (again) |
| `UploadPurged` | The sweeper removed the session's data after retention | `Blobs` (objects removed in that run) | the sweeper |

Every event extends `UploadEvent`, which carries the session's fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `UploadId` | `string` | Session id. Dedupe on it. |
| `Owner` | `string \| null` | The session's owner. |
| `FileName` | `string` | The client's file name. (`Name` is the event name, which routing reads.) |
| `Size` | `number` | Declared size in bytes. |
| `Metadata` | `Record<string, unknown>` | The session metadata. |
| `TempFs`, `FilesFs` | `string` | Provider names of the session. |
| `Status` | `UploadStatus` | The session status when the event was built. |
| `CreatedAt` | `DateTime` | When the event was created (from `QueueMessage`). |

`UPLOAD_EVENTS` lists the twelve classes and `UPLOAD_EVENT_NAMES` their names.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.routing.<UploadEvent>.connection` | `string` | `'upload-events'` for all twelve | a `queue.connections` name | Where the event goes. |
| `queue.connections[name='upload-events']` | connection | `BlackHoleQueueClient`, channels `upload-jobs` / `upload-events` | | The sink the shipped routes use. |
| `upload.assembly.staleAfter` | `string` | `'30m'` | a duration above zero | Grace before the sweeper re-emits an owed final event. |

Route the events you consume to a real connection:

```ts
// config/queue.ts in your app
export default {
  queue: {
    routing: {
      UploadCompleted: { connection: 'events', channel: '/topic/uploads' },
      UploadFailed: { connection: 'events', channel: '/topic/uploads' },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Event delivery | `queue.routing.<Event>` → the `QueueClient` of that connection | `BlackHoleQueueClient` | any queue transport | Route the event to another connection. |
| `UploadEvents` | `UploadEvents`, `@Singleton()` | `stage()` (best effort) and `final()` (emit, then stamp `final_event_at`) | none | Not meant to be replaced. |
| Event classes | `@Event()` classes extending `UploadEvent` | the twelve above | none | Consume them; do not emit them yourself. |

## Important behaviour

- **After the commit, never before.** That is also why a caller must not wrap the service in its own transaction: inside it, the events would go out before the data they report is committed.
- **Final events can come twice.** A crash between the emit and the `final_event_at` stamp, or a slow stamp racing the sweeper, emits again. Consumers must be idempotent, keyed by `UploadId`.
- **A failed final emit is retried late.** The sweeper waits `upload.assembly.staleAfter` after the session became final, so a request still finishing its own emit is not doubled. With the defaults that is 30 minutes or more.
- **Finished sessions with an owed event are not purged** until the event was delivered.
- **Events do not replace `onCompleted`.** Work the request depends on, such as attaching the file to a record, belongs in `onCompleted` or the `upload.complete` hook; events are for other consumers.
- **`UploadPartStored` is chatty.** A 1 GiB file in 8 MiB parts gives 128 of them. Leave it on the black hole unless you consume it.
- **`Metadata` travels in every event.** Keep secrets out of session metadata.
- **Consumers build events through DI.** Every event constructor argument is optional, because `QueueService.consume()` creates the instance with no arguments and fills it from the payload.

## Examples

### Index a document once its upload completed

```ts sample
import { DI } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';
import { UploadCompleted } from '@spinajs/upload';

/** Your search index; `indexed` survives restarts, so a repeated event is skipped. */
export interface DocumentIndex {
  indexed(uploadId: string): Promise<boolean>;
  add(uploadId: string, filesFs: string, fileKey: string, mime: string): Promise<void>;
}

export async function startDocumentIndexer(index: DocumentIndex): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume<UploadCompleted>(UploadCompleted, async (event) => {
    // final events are at least once: dedupe on UploadId
    if (await index.indexed(event.UploadId)) return;
    await index.add(event.UploadId, event.FilesFs, event.FileKey, event.Mime);
  });
}
```

Route `UploadCompleted` to the connection this worker consumes from, as shown above.

## Related

- [Connections and routing](../queue/02-connections-and-routing.md): `queue.routing` and `queue.connections`.
- [Events and jobs](../queue/01-events-and-jobs.md): consuming events.
- [Sweeper](11-sweeper.md): the re-emit step.
