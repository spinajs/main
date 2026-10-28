# Upload job and worker

`LazyUploadJob` is the `@spinajs/queue` job that `HttpLazyFileUploader` emits. A consumer of the job copies the file from the source to the target filesystem and removes the source copy.

`LazyUploadJob` is exported from `@spinajs/http-lazy-file-uploader`. The `fs-lazy:process` command is not exported; `@spinajs/cli` loads it from the package's `cli` folder.

## How it works

1. `HttpLazyFileUploader.upload()` calls `LazyUploadJob.emit()`. `QueueJob.emit()` sets `Persistent: true`, `Type: Job`, `Name: 'LazyUploadJob'` and passes the message to `QueueService.emit()`.
2. `QueueService` sends it on the connection named by `queue.default`, to the channel in `queue.routing.LazyUploadJob`, else to the connection's `defaultQueueChannel` (with a `No routing for event` warning).
3. A consumer subscribed with `QueueService.consume(LazyUploadJob)` receives every message named `LazyUploadJob`. It resolves the job class from DI, hydrates it with the message and creates or reads its `JobModel` row.
4. `LazyUploadJob.execute()` resolves both filesystems with `getFs()`. An empty or unknown name throws `IOFail` (`Filesystem <name> not exists`); for an unknown name its `inner` is the `ResolveException` from `@spinajs/fs`.
5. It reports progress `0`, runs `sourceFs.copy(Path, Path, targetFs)`, runs `sourceFs.rm(Path)` when `DeleteAfterUpload` is `true`, and reports progress `100`.
6. It returns `'finished'`. The consumer stores it in `JobModel.Result` and sets `Status` to `success`.
7. An error marks the row `retrying` or `dead` (`RetryCount` is not set, so the first failure is final) and is rethrown to the transport for its dead-letter policy.

```mermaid
sequenceDiagram
  participant Web as HttpLazyFileUploader
  participant Queue as QueueService
  participant Broker
  participant Consumer as QueueService.consume
  participant Job as LazyUploadJob
  participant Src as source fs
  participant Dst as target fs
  Web->>Queue: LazyUploadJob.emit(...)
  Queue->>Broker: channel from queue.routing.LazyUploadJob
  Broker->>Consumer: message Name = LazyUploadJob
  Consumer->>Job: DI.resolve(LazyUploadJob), hydrate(message)
  Consumer->>Job: execute(progress)
  Job->>Src: copy(Path, Path, Dst)
  Job->>Src: rm(Path) when DeleteAfterUpload
  Job-->>Consumer: 'finished' -> JobModel success
```

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Job({ runAs: 'initiator' })` on `LazyUploadJob` | class | `runAs` | Marks the class as a queue job. A `QueueMessageHook` (eg. `authz-queue`) runs `execute()` as the principal that emitted it. |
| `@Command('fs-lazy:process', 'Process lazy file upload')` on `ProcessFiles` | class | name, description | Declares the `spinajs fs-lazy:process` CLI command. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.routing.LazyUploadJob` | `string \| IMessageRoutingOption \| (string \| IMessageRoutingOption)[]` | `'/queue/lazy-file-upload'` (shipped) | channel name or routing option | Channel of the job. Override it in your configuration. See [`@spinajs/queue`](../queue/README.md). |
| `queue.default` | `string` | from your queue config | connection name | Connection the job is sent on and consumed from. |
| `system.dirs.cli` | `string[]` | the package adds `node_modules/@spinajs/http-lazy-file-uploader/lib/cli`, under `WORKSPACE_ROOT_PATH` or the working directory and one level up | directory paths | Where `@spinajs/cli` finds `fs-lazy:process`. |

```ts sample
const config = {
  queue: {
    routing: {
      LazyUploadJob: '/queue/lazy-file-upload',
    },
  },
  fs: {
    providers: [
      { service: 'fsNative', name: 'media-local', basePath: '/srv/media' },
    ],
  },
};

export default config;
```

## Schema

The job is tracked in the `@spinajs/queue` `JobModel` table (`queue_jobs`). This package adds no tables. Rows for this job have `Name = 'LazyUploadJob'`, `Result = 'finished'` on success, `Progress` `0` then `100`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `LazyUploadJob` | not registered; the consumer calls `DI.resolve(LazyUploadJob)`, so it is a singleton hydrated per message | `LazyUploadJob` | none shipped | Consume the exported class in your own process (see the example below), or emit your own job from your own uploader ([Custom uploaders and jobs](03-custom-uploaders-and-jobs.md)). |
| `ProcessFiles` (`fs-lazy:process`) | `CliCommand`, found by `@spinajs/cli` in `system.dirs.cli`; `QueueService` injected with `@Autoinject()` | `ProcessFiles` | a long-running process that calls `QueueService.consume()` | Not exported, so it cannot be subclassed. Use the worker example below. |
| source and target filesystem | named `@spinajs/fs` providers, looked up with `getFs(name)` per job | `__file_upload_default_provider__` (source) | any provider: `fsNative`, `fsS3`, `fsFTP`, `fsOneDrive`, your own | Configure `fs.providers`; see [`@spinajs/fs`](../fs/README.md). |

## Important behaviour

- `spinajs fs-lazy:process` consumes jobs until the process gets `SIGINT` or `SIGTERM`, then stops consuming and exits.
- The consumer resolves the job class as a DI singleton and hydrates it per message. Run one job at a time per process; concurrent deliveries share the instance.
- The copy is not atomic: a failure after `copy()` and before `rm()` leaves the file in both filesystems, and the job is marked `dead` with no retry.
- The worker needs the source file. With the default `os.tmpdir()` source, run the worker on the web host.
- The worker needs the same `fs.providers` names as the web process: the job carries names, not paths.
- Queue messages are at-least-once. With `queue.deduplicate` (default `true`) a redelivered job whose row is `success` or `dead` is skipped.

## Best practices

- Keep `queue.routing.LazyUploadJob` on a dedicated channel (the shipped default) so a slow S3 copy does not delay other jobs on the default channel.
- Watch `JobModel` rows with `Name = 'LazyUploadJob'` and `Status = 'dead'`; with `deleteAfterUpload` the source file of a dead job is still in the source filesystem and can be copied again.
- Give the worker the same configuration files as the web process, so provider names and routing match.

## Patterns and antipatterns

```ts
// Don't: a worker on another host cannot read the web host's os.tmpdir() source.
// Do: run `spinajs fs-lazy:process` on the web host, or point the route's `fs` at a filesystem both hosts reach.
```

## Examples

### Run the worker in a long-running process

```ts sample
import { DI } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';
import { LazyUploadJob } from '@spinajs/http-lazy-file-uploader';

export async function startUploadWorker() {
  const queue = await DI.resolve(QueueService);
  await queue.consume(LazyUploadJob);
}
```

### Run the `fs-lazy:process` command

The package configuration adds its `cli` folder to `system.dirs.cli`, so the command appears in `spinajs --help`.

```sh
npx spinajs fs-lazy:process
```

It consumes jobs until the process gets `SIGINT` or `SIGTERM`.

## Related

- [Lazy file upload](01-lazy-file-upload.md): where the job comes from.
- [Custom uploaders and jobs](03-custom-uploaders-and-jobs.md): emit your own job and expose its id.
- [`@spinajs/queue`](../queue/README.md): routing, connections, `JobModel`, retries and `QueueMessageHook`.
- [`@spinajs/cli`](../cli/README.md): how `system.dirs.cli` and command exit work.
