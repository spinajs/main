# Logging

`UploadService`, `UploadStorage`, `UploadStore`, `ContentTypeCheck`, `UploadEvents`, `UploadSweeper` and `UploadController` log through one `@spinajs/log` logger named `upload`. Every entry carries its data as fields, so a log target can filter by upload.

## How it works

1. Each class injects `@Logger('upload')`.
2. Each entry is written in the fields form, `Log.info({ uploadId, ... }, message)`; the message refers to the fields by name (`'Upload ${uploadId} created'`).
3. The `logger.rules` of your app decide which levels of `upload` reach which target.

| Level | Entries | Fields (`uploadId` on all but the sweep summary, the store warning and the 500 entry on create) |
| --- | --- | --- |
| `info` | session created; assembly started; completed; failed; aborted; expired; purged; the sweeper's run summary | `owner` on all but the summary; `size`, `partCount`, `metadataKeys` (created); `partCount` (assembly started); `size`, `sha256` (completed); `code` (failed); `status`, `blobs` (purged); the seven counts (summary) |
| `debug` | part stored; content checked; claim taken; a final event or handler already recorded by a concurrent request | `part`, `size`, `offset`; `detectedMime`, `detectorId`, `accepted` |
| `warn` | part rejected; stored parts changed at assembly; a stale claim taken over or released by the sweeper; assembly stopped by an upload refusal; an event not emitted; a final event re-emitted by the sweeper; a final event emitted but not recorded; an object, blob row or session folder not removed; a stored part that cannot be read; a content detector that failed; an object that could not be marked garbage; a release event that was not built; a session id that is not a valid folder name; the owner's create insert retried after a lock conflict (`Upload create for owner ${owner} hit a lock conflict; retrying once`, from `UploadStore`) | `part`, `code`, `parts`, `event`, `fs`, `key`, `detectorId`, `error`; `owner` and `error` (lock conflict, no `uploadId`) |
| `error` | an unexpected assembly failure (after the claim was released); a claim that could not be released; `onAborted` failed; the sweeper failed on one item; a request the controller answered as `500` `upload.internal` | `error`; `stage` (request stage), and `uploadId` when the route has one, for the last |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `logger.rules[]` with `name: 'upload'` | rule | none: the app's `*` rules apply | a rule of `@spinajs/log` | Level and target of the upload entries. |

```ts
// config/log.ts in your app: upload warnings and errors to their own file, debug only in development
export default {
  logger: {
    targets: [
      { name: 'Console', type: 'ConsoleTarget' },
      { name: 'Uploads', type: 'FileTarget', options: { path: 'logs/uploads.log' } },
    ],
    rules: [
      { name: 'upload', level: process.env.NODE_ENV === 'production' ? 'info' : 'debug', target: 'Console' },
      { name: 'upload', level: 'warn', target: 'Uploads' },
      { name: '*', level: 'info', target: 'Console' },
    ],
  },
};
```

## Important behaviour

- **No content is logged.** Part bytes and the raw `Content-Digest` header never appear. Hashes appear only as hex in fields such as `sha256`.
- **No metadata values are logged.** The created entry logs `metadataKeys` only, because metadata carries app data.
- **Object keys are logged** in removal warnings (`fs`, `key`), so a failed removal can be found and cleaned by hand.
- **A part refusal is logged once**, at `warn`, with its `code`. Requests refused before the service runs (a policy, the lookup, `authorize`) are not logged by the upload.
- **A `500` is logged, not echoed.** The controller answers an error the framework would turn into a generic `500` with `{ code: 'upload.internal', message: 'Internal error' }` and logs the original error at `error`, with the `uploadId` when the route has an `:upload` parameter, so no path or stack reaches the client. Handlers in `http.errors.handlers` do not see these upload-route errors.
- **`error` entries carry the error object** in `error`; the target's serializer decides how much of it is written.

## Best practices

- Alert on `upload` `error` entries: each one is a failure the client could not fix by retrying.
- Watch the `warn` entries "was not removed": they show storage that refuses deletes, and objects the sweeper retries every run.
- Keep `debug` off in production: one entry per stored part adds up.

## Related

- [Configuration and rules](../log/02-configuration-and-rules.md): `logger.targets` and `logger.rules`.
- [Structured logging and serializers](../log/11-structured-logging-and-serializers.md): how fields are written.
- [Sweeper](11-sweeper.md): the summary entry of each run.
