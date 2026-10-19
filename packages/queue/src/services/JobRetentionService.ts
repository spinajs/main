import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Config } from '@spinajs/configuration';
import { DateTime } from 'luxon';
import { IQueueRetentionOptions, JobRetentionService } from '../interfaces.js';
import { tracked } from '../hook-runner.js';
import { JobModel, JobStatus, JOB_TERMINAL_STATUSES } from '../models/JobModel.js';

/**
 * How often ( ms ) to run the purge when `queue.retention.interval` is not set.
 */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Built-in {@link JobRetentionService}. Periodically deletes terminal jobs older than the
 * configured `maxAge` so the `queue_jobs` table doesn't grow unbounded. All timings / statuses
 * come from the injected `queue.retention` config block - nothing is hardcoded except the
 * fallback interval used when none is configured.
 */
@Injectable(JobRetentionService)
export class DefaultJobRetentionService extends JobRetentionService {
  @Logger('queue')
  protected Log: Log;

  protected RetentionTimer?: ReturnType<typeof setInterval>;

  // A singleton first resolved without constructor options ( a plain DI.resolve ) is the instance
  // QueueService later gets, so the configured block must still drive it.
  @Config('queue.retention')
  protected RetentionConfig?: IQueueRetentionOptions;

  public async resolve() {
    this.startRetention();
  }

  public async dispose() {
    if (this.RetentionTimer) {
      clearInterval(this.RetentionTimer);
      this.RetentionTimer = undefined;
    }
  }

  /**
   * Starts the periodic job-retention purge when configured. No-op if retention is disabled
   * or no `maxAge` is set.
   */
  protected startRetention() {
    const options = this.Options ?? this.RetentionConfig;
    if (!options?.enabled || !options.maxAge) {
      return;
    }

    const interval = options.interval ?? DEFAULT_INTERVAL_MS;
    const maxAge = options.maxAge;

    this.RetentionTimer = setInterval(() => {
      const cutoff = DateTime.now().minus({ milliseconds: maxAge });
      this.purgeJobs(cutoff, options.statuses)
        .then((n) => {
          if (n > 0) {
            this.Log.info({ count: n, cutoff }, 'Retention purge removed ${count} job(s) older than ${cutoff}');
          }
        })
        .catch((err) => this.Log.error(err, 'Job retention purge failed'));
    }, interval);

    // don't keep the process alive just for the purge timer
    (this.RetentionTimer as { unref?: () => void }).unref?.();

    this.Log.info({ maxAge, interval }, 'Job retention enabled: purging jobs older than ${maxAge}ms every ${interval}ms');
  }

  /**
   * Deletes terminal ( or given ) jobs created before `olderThan`. The set is selected with the
   * JobModel query scopes ( status + date ), then removed by id.
   */
  public async purgeJobs(olderThan: DateTime, statuses?: string[]): Promise<number> {
    return tracked(async () => {
      const rows = await JobModel.query()
        .columns(['Id'])
        .withStatus((statuses as JobStatus[]) ?? JOB_TERMINAL_STATUSES)
        .olderThan(olderThan);

      const ids = rows.map((r) => r.Id);
      if (ids.length === 0) {
        return 0;
      }

      await JobModel.destroy(ids);
      return ids.length;
    });
  }
}
