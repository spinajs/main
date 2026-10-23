# Sweeper

`UploadSweeper.sweep()` removes what the upload leaves behind: objects of refused or crashed writes, abandoned assembly claims, sessions nobody finished, and finished sessions past retention. It also delivers final events whose emit failed. Run it on a schedule, through `@spinajs/scheduler` or cron.

## How it works

`sweep({ signal? })` reads in keyset pages of `upload.sweeper.batch` rows and runs seven steps, in this order:

1. **Garbage blobs:** every `garbage` blob is removed with `rm(key)` on its provider, then its row is deleted.
2. **Stale writes:** a `writing` blob last changed more than `upload.assembly.staleAfter` (a crashed or very slow write) becomes `garbage` and is removed. A blob that went `live` since the read is left alone.
3. **Stale claims:** an `assembling` session whose claim is older than `upload.assembly.staleAfter` goes back to `open`; its partial merged file becomes garbage and is removed. Emits `UploadAssemblyReleased` with `Reason: 'stale'`.
4. **Expiry:** an `open` session past `expiresAt` becomes `expired` through `UploadService.expire()` (which emits `UploadExpired`); its part rows go and their objects are removed.
5. **Owed final events:** a session with `final_event` set and `final_event_at` still null, last changed more than `upload.assembly.staleAfter` ago, gets its final event emitted again (at least once).
6. **Completed sessions past retention** (`upload.sweeper.retainFinished`, counted from `updated_at`, final event delivered): their part rows and part objects go, then the session folder `<prefix>/<id>` on the temp provider. The session row and the merged file stay, and the state keeps answering `missingParts: []` and `offset` equal to `size`. Emits `UploadPurged`.
7. **Failed, aborted and expired sessions past retention** (same age rule, final event delivered): every blob of the session becomes garbage and is removed, then the session folder, then the session row. The row is deleted, so the session answers `404` `upload.not_found` afterwards. Emits `UploadPurged`.

Leftovers go first, so an object a later step fails to remove is tried only once per run. Claims are released before expiry, so a released session past `expiresAt` expires in the same run. Events are re-emitted before the purge, which skips sessions that still owe one.

`sweep()` returns `SweepResult`, the counts of this run only:

| Field | Counts |
| --- | --- |
| `expired` | Open sessions that became `expired`. |
| `released` | Stale claims released. |
| `reemitted` | Owed final events emitted again. |
| `purged` | Sessions purged after retention. |
| `removedBlobs` | Objects removed together with their rows. |
| `keptBlobs` | Objects whose `rm` failed; their rows stay for the next run. |
| `errors` | Unexpected failures on one item, each logged at `error` with its `uploadId`. |

## Scheduling

### With `@spinajs/scheduler`

Install `@spinajs/scheduler` and import the subpath once, anywhere that runs at boot:

```ts
import '@spinajs/upload/scheduler';
```

- This registers the upload configuration schema and `UploadSweepTask` under the schedule `upload.sweep`: every `upload.sweeper.every` (default 15 minutes), `runOn: 'leader'` (one node in a cluster), `overlap: 'skip'`, and the scheduler's default misfire `run-once`.
- `every` is read when the scheduler builds its definitions, so it follows the configuration, not the import order.
- A `scheduler.schedules` entry named `upload.sweep` overrides the options, for example `{ name: 'upload.sweep', every: '5m' }`.
- A run with `errors > 0` fails, with the counts in its error message, so the scheduler records it as failed; the next run tries the failed items again. The task declares no retry: add a `retry` to the `upload.sweep` entry of `scheduler.schedules` to retry a failed run sooner. A successful run stores the `SweepResult` as its result.
- Stopping the scheduler aborts the run before its next batch; the next run goes on from the rows that are left.
- Do not add the package's `lib` folder to `system.dirs.schedules`: the scan would import every file of the package.

### With cron

Without the scheduler, run the command from cron:

```sh
npx spinajs upload:sweep
```

It prints one `<count> <name>` line per `SweepResult` field and exits with code `1` when `errors > 0`. The package adds its command folder to `system.dirs.cli`. The command first runs the connection's `Migration.OnStartup` pass, as an app boot does.

`npx spinajs` is its own process: it loads your config files but not your app's entry module. Define the fs providers, the database connection and the queue routes in config files, and import provider packages such as `@spinajs/fs-s3` from a config module, so the command sees the same storage as the app.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `upload.sweeper.every` | `string` | `'15m'` | a duration above zero | Interval of the `upload.sweep` schedule. |
| `upload.sweeper.retainFinished` | `string` | `'7d'` | a duration (zero allowed) | Age, counted from the last update and once the final event was delivered, after which the sweeper purges a finished session. A completed session loses its parts; its row and file stay. A failed, aborted or expired session is deleted. |
| `upload.sweeper.batch` | `integer` | `200` | `>= 1` | Rows read per query. |
| `upload.assembly.staleAfter` | `string` | `'30m'` | a duration above zero | Age of an abandoned claim or `writing` blob; also the grace before an owed final event is re-emitted. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `UploadSweeper` | `UploadSweeper`, `@Singleton()` | `UploadSweeper` | none | Call `sweep()` from your own job if you schedule another way. Not meant to be subclassed. |
| `UploadSweepTask` | `@Schedule('upload.sweep', …)` in `@spinajs/upload/scheduler` | runs `sweep({ signal })` | a `scheduler.schedules` override | Override its options by config; do not import the subpath when you schedule the sweep yourself. |
| `UploadSweep` | CLI command `upload:sweep` | runs `sweep()` once | none | Run it from cron. |

## Important behaviour

- **Idempotent and concurrent-safe.** Every change is a conditional `UPDATE` or `DELETE`. A second sweep at the same time (cron next to the scheduler) only finds less to do, and a run after a clean one changes nothing.
- **No storage listing.** Objects are found through `upload_blobs` only.
- **A failed removal keeps its row** and is retried on the next run; the run logs a `warn` and counts it in `keptBlobs`. A failed, aborted or expired session is deleted only once every one of its objects is gone.
- **A completed session keeps its row and file.** If your `fileDir()` puts the file under the session folder, the folder is not removed.
- **`UploadPurged.Blobs` counts this run.** Objects removed by earlier runs or requests are not in it.
- **An unexpected failure on one item** is logged at `error`, counted in `errors`, and the other items go on.
- **Final events are delayed by `staleAfter`.** A session's own request may still be emitting its final event; the grace keeps the sweeper from emitting it a second time in that window.
- **`staleAfter` must exceed your slowest part transfer and assembly.** A write still `writing` or a claim older than it is reclaimed, and the slow request then fails with `upload.part_lost` or `upload.file_lost`.
- **A bad duration stops the run.** `sweep()` reads `staleAfter` and `retainFinished` before the first step and throws `InvalidOption` for a value the schema would have refused at boot; only failures on single items are counted in `errors`.
- **`every` and `staleAfter` must be above zero.** The schema refuses `'0s'` at boot; `retainFinished` accepts it.
- **`retainFinished` counts from the last change.** For a completed session that is the completion; for an expired one, the expiry.

## Best practices

- Run the sweeper. Without it, expired sessions keep their parts, stale claims block completes until `staleAfter`, and failed final emits are never retried.
- Keep `every` well below `staleAfter`, so abandoned claims are released soon after they go stale.
- Size `retainFinished` to how long clients may read the state of a finished session; after the purge, failed, aborted and expired sessions answer `404`.

## Examples

### Sweep from an existing maintenance job

```ts sample
import { DI } from '@spinajs/di';
import { UploadSweeper } from '@spinajs/upload';
import type { SweepResult } from '@spinajs/upload';

export async function nightlyMaintenance(signal: AbortSignal): Promise<SweepResult> {
  const sweeper = await DI.resolve(UploadSweeper);
  const result = await sweeper.sweep({ signal });
  if (result.errors > 0) throw new Error(`upload sweep: ${result.errors} item(s) failed`);
  return result;
}
```

## Related

- [Integrity](03-integrity.md#blob-tracking): the blob states the sweeper reads.
- [Events](09-events.md): the at-least-once final events.
- [Domain lists and sync](../email-verification/04-domain-lists-and-sync.md#scheduled-sync): the same scheduler subpath layout in another package.
