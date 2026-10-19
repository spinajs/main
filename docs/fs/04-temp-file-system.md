# Temp file system

`fsTemp` is a provider for temporary files. It stores nothing itself: every call goes to a backend provider you name, so temp files can live on local disk, S3 or FTP. A [cleanup strategy](05-temp-cleanup-strategies.md) deletes old files on a schedule.

## How it works

1. `fsService` creates the backend first: the temp entry's `provider` key makes it a dependency, whatever the config order.
2. `fsTemp.resolve()` throws `ResolveException` when `provider` is not set, or names the temp provider itself.
3. It takes the backend with `getFs(provider)`. This is the **raw** backend: decorators run after all providers exist.
4. It finds the class registered under `TempCleanupStrategy` whose name equals `cleanupStrategy` (default `MaxAgeTempCleanupStrategy`), or throws `ResolveException`.
5. It resolves a new strategy instance. With `cleanup` not `true` it logs that cleanup is off and stops here.
6. Otherwise it calls `strategy.start(backend, options)`. A strategy may throw here, eg. `CronTempCleanupStrategy` without `cleanupCronExpression`, which fails the boot.
7. Every file call (`read`, `write`, `zip`, ...) is forwarded to the backend. `zip()` and `unzip()` default their destination to the temp provider, not the backend.
8. `dispose()` stops the strategy. It does **not** dispose the backend.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers[].service` | `string` | | `fsTemp` | Selects this provider. |
| `fs.providers[].name` | `string` | required | | Provider name. `fs-temp` is the name `fsNative.zip()` and the `zip()`/`unzip()` helpers fall back to. |
| `fs.providers[].provider` | `string` | required | name of another provider | Backend that holds the files. |
| `fs.providers[].cleanup` | `boolean` | unset (off) | | Starts the cleanup strategy at boot. |
| `fs.providers[].cleanupStrategy` | `string` | `MaxAgeTempCleanupStrategy` | `MaxAgeTempCleanupStrategy`, `CronTempCleanupStrategy`, class name of your own strategy | Strategy class. |
| `fs.providers[].maxFileAge` | `number` | `3600` | seconds | Age after which a file is deleted, used by both shipped strategies. |
| `fs.providers[].cleanupInterval` | `number` | `600000` | ms | Sweep interval of `MaxAgeTempCleanupStrategy`. Ignored, with a warning, by `CronTempCleanupStrategy`. |
| `fs.providers[].cleanupCronExpression` | `string` | unset | cron, 6 fields with seconds supported | Schedule of `CronTempCleanupStrategy`. Required by it. |

```ts sample
const config = {
  fs: {
    defaultProvider: 'documents',
    providers: [
      { service: 'fsNative', name: 'documents', basePath: './data/documents' },
      { service: 'fsNative', name: 'fs-temp-local', basePath: './data/temp' },
      {
        service: 'fsTemp',
        name: 'fs-temp',
        provider: 'fs-temp-local',
        cleanup: true,
        cleanupStrategy: 'CronTempCleanupStrategy',
        cleanupCronExpression: '0 0 * * * *',
        maxFileAge: 6 * 60 * 60,
      },
    ],
  },
};

export default config;
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fsTemp` | `'fs'`, `PerInstanceCheck` per `name` | `fsTemp` | any provider used directly as temp storage | Swap the backend with `provider`; swap the policy with `cleanupStrategy`. Subclass with `@Injectable('fs')` and `@PerInstanceCheck()` to change forwarding. |
| Backend | any provider | `fsNative` | `fsS3`, `fsFTP`, `fsOneDrive`, your own | Set `provider` to its name. |
| Cleanup strategy | `TempCleanupStrategy`, `NewInstance` | `MaxAgeTempCleanupStrategy` | `CronTempCleanupStrategy` | See [Temp cleanup strategies](05-temp-cleanup-strategies.md). |

The flexibility is in configuration: the same `fs-temp` name can point at local disk in development and at S3 in production, with a different cleanup policy each, and no code change.

```ts
// production: temp files on S3, swept by cron every night at 03:00
{ service: 'fsS3', name: 'temp-s3', bucket: 'app-temp' },
{ service: 'fsTemp', name: 'fs-temp', provider: 'temp-s3', cleanup: true,
  cleanupStrategy: 'CronTempCleanupStrategy', cleanupCronExpression: '0 0 3 * * *', maxFileAge: 24 * 60 * 60 }
```

The `fsS3` keys (`bucket`, `createBucketIfNotExists`, `signer`) come from `@spinajs/fs-s3`. `fsS3` also needs a provider named `fs-temp-s3` (`@FileSystem('fs-temp-s3')`) for its local copies.

## Important behaviour

- `Name` and `ServiceName` return the temp provider name, not the backend name.
- `tmppath(ext)` returns the backend's `tmppath(ext)`, so for `fsNative` it is an absolute path under the backend's `basePath`.
- Decorators wrap the temp provider and the backend separately. The temp provider still calls the **raw** backend, so a decorator on the backend does not see calls made through `fs-temp`.
- The shipped strategies sweep only the first level of the backend root; files in subdirectories stay.
- Two temp providers on one backend sweep the same root: one may delete the other's files.

## Best practices

- Give the temp backend its own `basePath` (or bucket). The sweep deletes every first-level entry older than `maxFileAge`.
- Set `cleanup: true` in long-running processes; it is off by default.
- Keep `maxFileAge` longer than your slowest job that reads a temp file.

## Patterns and antipatterns

```ts
// Don't: temp backend shares the root with real data, so the sweep deletes documents older than an hour
{ service: 'fsTemp', name: 'fs-temp', provider: 'documents', cleanup: true }

// Do: a dedicated backend
{ service: 'fsNative', name: 'fs-temp-local', basePath: './data/temp' },
{ service: 'fsTemp', name: 'fs-temp', provider: 'fs-temp-local', cleanup: true }
```

## Examples

### Render a report into a temp file and move it to permanent storage

```ts sample
import { getFs } from '@spinajs/fs';

export async function publishReport(month: string, csv: string): Promise<void> {
  const temp = getFs('fs-temp');
  const reports = getFs('reports');

  const name = temp.tmpname('.csv');
  await temp.write(name, csv, 'utf-8');

  await temp.move(name, `${month}/report.csv`, reports);
}
```

## Related

- [Temp cleanup strategies](05-temp-cleanup-strategies.md): which files are deleted, and when.
- [Providers and configuration](01-providers-and-configuration.md): dependency ordering of providers.
- [Local provider](03-local-provider.md): the usual backend.
