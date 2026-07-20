import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';
import { JobRetentionService } from '../interfaces.js';
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
    if (!this.Options?.enabled || !this.Options.maxAge) {
      return;
    }

    const interval = this.Options.interval ?? DEFAULT_INTERVAL_MS;
    const maxAge = this.Options.maxAge;

    this.RetentionTimer = setInterval(() => {
      const cutoff = DateTime.now().minus({ milliseconds: maxAge });
      this.purgeJobs(cutoff, this.Options.statuses)
        .then((n) => {
          if (n > 0) {
            this.Log.info(`Retention purge removed ${n} job(s) older than ${cutoff.toISO()}`);
          }
        })
        .catch((err) => this.Log.error(err, 'Job retention purge failed'));
    }, interval);

    // don't keep the process alive just for the purge timer
    (this.RetentionTimer as { unref?: () => void }).unref?.();

    this.Log.info(`Job retention enabled: purging jobs older than ${maxAge}ms every ${interval}ms`);
  }

  /**
   * Deletes terminal ( or given ) jobs created before `olderThan`. The set is selected with the
   * JobModel query scopes ( status + date ), then removed by id.
   */
  public async purgeJobs(olderThan: DateTime, statuses?: string[]): Promise<number> {
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
  }
}
