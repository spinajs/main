# Job retention

A `JobRetentionService` deletes old rows from `queue_jobs` on a timer, so the table does not grow without bound. The implementation is chosen by `queue.retention.service`; the built-in `DefaultJobRetentionService` deletes finished jobs older than `maxAge`. Retention is off by default.

## How it works

1. `DefaultQueueService.Retention` is decorated `@AutoinjectService('queue.retention', JobRetentionService, { optional: true })`. When the queue is built, DI resolves the `JobRetentionService` registration whose class name equals `queue.retention.service`, with the whole `queue.retention` block as the constructor's `Options`. No `queue.retention` block: the `Configuration` logger warns, `Retention` stays `undefined`, and the queue still builds.
2. `JobRetentionService` extends `AsyncService`, so DI awaits its `resolve()`.
3. `DefaultJobRetentionService.resolve()` starts the timer only when `enabled` is `true` and `maxAge` is set. The timer is `unref()`'d, so it never keeps the process alive.
4. Every `interval` ms the timer calls `purgeJobs(now - maxAge, statuses)`. It logs the count when rows were removed, and logs errors without stopping the timer.
5. `purgeJobs(olderThan, statuses?)` runs through the [tracking hooks](07-tracking-hooks.md): it deletes the rows with a status in `statuses` (default `success`, `error`, `dead`) and `CreatedAt` before `olderThan` in one `JobModel.destroy().withStatus(...).olderThan(...)`, and returns `RowsAffected`.
6. `DefaultQueueService.dispose()` calls `Retention.dispose()`, which clears the timer.

## API

| Export | Kind | Meaning |
| --- | --- | --- |
| `JobRetentionService` | abstract class, extends `AsyncService` | `Options: IQueueRetentionOptions`; `ServiceName` (`Options.service`); `abstract purgeJobs(olderThan: DateTime, statuses?: string[]): Promise<number>` |
| `DefaultJobRetentionService` | class, `@Injectable(JobRetentionService)` | Timer in `resolve()`, cleared in `dispose()`; `purgeJobs()` by status and `CreatedAt`; protected `startRetention()` and `RetentionTimer` |
| `IQueueRetentionOptions` | interface | `service`, `enabled?`, `maxAge?`, `statuses?`, `interval?` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `queue.retention.service` | `string` | `'DefaultJobRetentionService'` | class name of a registered `JobRetentionService` | Implementation to build |
| `queue.retention.enabled` | `boolean` | `false` | | Start the periodic purge |
| `queue.retention.maxAge` | `number` (ms) | unset | `> 0` | Rows created longer ago than this are purged. Unset: no purge, even when enabled |
| `queue.retention.statuses` | `string[]` | `['success', 'error', 'dead']` | `JobStatus` values | Statuses to purge |
| `queue.retention.interval` | `number` (ms) | `3600000` (1 hour) | `> 0` | Time between purges |

The whole block is passed to the implementation, so a custom implementation can read its own extra keys.

```ts
// config/queue.ts
export default {
  queue: {
    retention: {
      service: 'DefaultJobRetentionService',
      enabled: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      interval: 60 * 60 * 1000,
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Retention service | `JobRetentionService`, selected by class name from `queue.retention.service` and injected into `DefaultQueueService`; singleton | `DefaultJobRetentionService` | none shipped | Extend `DefaultJobRetentionService` and override `purgeJobs()` or `startRetention()`, or extend `JobRetentionService` directly; decorate `@Injectable(JobRetentionService)` and name the class in `queue.retention.service` |

### Retention service: extend the default

Override `purgeJobs()` to change what is deleted while keeping the default timer. Calling `super.purgeJobs()` keeps the queries inside the tracking hooks. Register the class (import its module) before `QueueService` is first resolved.

This one keeps failed jobs longer than successful ones, reading an extra key from the same config block.

```ts sample
import { Injectable } from '@spinajs/di';
import { DefaultJobRetentionService, IQueueRetentionOptions, JobRetentionService } from '@spinajs/queue';
import { DateTime } from 'luxon';

interface TieredRetentionOptions extends IQueueRetentionOptions {
  // extra time ( ms ) a dead or errored job is kept after maxAge
  failedGrace?: number;
}

@Injectable(JobRetentionService)
export class TieredJobRetentionService extends DefaultJobRetentionService {
  public async purgeJobs(olderThan: DateTime, _statuses?: string[]): Promise<number> {
    const grace = (this.Options as TieredRetentionOptions).failedGrace ?? 30 * 24 * 60 * 60 * 1000;

    const succeeded = await super.purgeJobs(olderThan, ['success']);
    const failed = await super.purgeJobs(olderThan.minus({ milliseconds: grace }), ['error', 'dead']);

    return succeeded + failed;
  }
}

// config/queue.ts
export const config = {
  queue: {
    retention: {
      service: 'TieredJobRetentionService',
      enabled: true,
      maxAge: 24 * 60 * 60 * 1000,
      failedGrace: 14 * 24 * 60 * 60 * 1000,
    },
  },
};
```

## Important behaviour

- **Off by default.** Rows accumulate until you set `enabled: true` and `maxAge`.
- **The first purge runs one `interval` after startup**, not at startup.
- **Age is `CreatedAt`, the first receipt**, not `FinishedAt`. A job that ran for a long time is purged as soon as its row is old enough and its status matches.
- **Every process that builds `QueueService` runs its own timer.** Web and worker processes all purge; the deletes are idempotent, but they multiply the load.
- **A manual resolve reads the config itself.** `DI.resolve(JobRetentionService)` before the queue is built creates the singleton without `Options`, and the queue then receives that instance. `DefaultJobRetentionService` then reads the `queue.retention` block, so the periodic purge still starts.
- **`tracked()` is not exported.** An implementation that queries `JobModel` itself bypasses the tracking hooks; call `super.purgeJobs()` from a `DefaultJobRetentionService` subclass to stay inside them.

## Best practices

- Purge only terminal statuses. A `created` or `retrying` job may still be redelivered; with its row gone, the next delivery creates a new row and its attempt count starts again from `0`.
- Keep `maxAge` longer than the broker's longest redelivery window, so a late duplicate still finds its terminal row and is skipped.
- Turn retention on in one process only (for example the worker) by setting `enabled` per environment.

## Examples

### Archive jobs to a file before deleting them

```ts sample
import { appendFile } from 'node:fs/promises';
import { Injectable } from '@spinajs/di';
import { JOB_TERMINAL_STATUSES, JobModel, JobRetentionService, JobStatus } from '@spinajs/queue';
import { DateTime } from 'luxon';

@Injectable(JobRetentionService)
export class ArchivingJobRetentionService extends JobRetentionService {
  protected Timer?: ReturnType<typeof setInterval>;

  public async resolve() {
    await super.resolve();

    const maxAge = this.Options?.maxAge;
    if (!this.Options?.enabled || !maxAge) {
      return;
    }

    this.Timer = setInterval(() => {
      this.purgeJobs(DateTime.now().minus({ milliseconds: maxAge }), this.Options.statuses).catch((err) => console.error('Job archive failed', err));
    }, this.Options.interval ?? 60 * 60 * 1000);
    this.Timer.unref();
  }

  public async dispose() {
    if (this.Timer) {
      clearInterval(this.Timer);
    }
  }

  public async purgeJobs(olderThan: DateTime, statuses?: string[]): Promise<number> {
    const rows = await JobModel.query()
      .withStatus((statuses as JobStatus[]) ?? JOB_TERMINAL_STATUSES)
      .olderThan(olderThan);

    if (rows.length === 0) {
      return 0;
    }

    const lines = rows.map((job) =>
      JSON.stringify({
        jobId: job.JobId,
        name: job.Name,
        status: job.Status,
        attempts: job.Attempt,
        result: job.Result,
        error: job.LastError,
        createdAt: job.CreatedAt?.toISO(),
        finishedAt: job.FinishedAt?.toISO(),
      }),
    );
    await appendFile(`archive/jobs-${DateTime.now().toFormat('yyyy-MM')}.jsonl`, `${lines.join('\n')}\n`);

    await JobModel.destroy(rows.map((job) => job.Id));
    return rows.length;
  }
}

// queue.retention: { service: 'ArchivingJobRetentionService', enabled: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
```

## Related

- [Job tracking](03-job-tracking.md): the `queue_jobs` table and its status values.
- [Tracking hooks](07-tracking-hooks.md): what `purgeJobs()` of the default runs inside.
- [Config-selected services](../configuration/08-config-selected-services.md): how `@AutoinjectService` picks the class.
- [Service lifecycle](../di/10-service-lifecycle.md): `resolve()` and `dispose()` of an `AsyncService`.
