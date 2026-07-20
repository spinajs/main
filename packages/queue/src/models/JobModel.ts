import { DateTime } from 'luxon';
import { ModelBase, Connection, Model, Json, CreatedAt, UpdatedAt, DateTime as DT, Primary, QueryScope, ISelectQueryBuilder } from '@spinajs/orm';

/**
 * Possible job lifecycle statuses.
 * - created:   dispatched, not yet picked up
 * - executing: currently running
 * - retrying:  failed, will be retried
 * - success:   finished ok ( terminal )
 * - error:     legacy generic failure ( terminal )
 * - dead:      failed and retries exhausted / dead-lettered ( terminal )
 */
export type JobStatus = 'created' | 'executing' | 'retrying' | 'success' | 'error' | 'dead';

/** Statuses a job can no longer leave - safe to report as done / purge. */
export const JOB_TERMINAL_STATUSES: JobStatus[] = ['success', 'error', 'dead'];

/** Statuses of jobs still in flight. */
export const JOB_ACTIVE_STATUSES: JobStatus[] = ['created', 'executing', 'retrying'];

/**
 * Reusable query scopes for {@link JobModel}. Available on any JobModel query
 * ( select / update / destroy ), so callers compose readable, safe queries eg.
 *
 *   await JobModel.destroy().terminal().olderThan(cutoff);
 *   await JobModel.query().byJobId(id).first();
 */
export class JobQueryScopes implements QueryScope {
  public byJobId(this: ISelectQueryBuilder<JobModel[]> & JobQueryScopes, jobId: string) {
    return this.where('JobId', jobId);
  }

  public withStatus(this: ISelectQueryBuilder<JobModel[]> & JobQueryScopes, status: JobStatus | JobStatus[]) {
    return Array.isArray(status) ? this.whereIn('Status', status) : this.where('Status', status);
  }

  /** Jobs in a terminal state ( success / error / dead ). */
  public terminal(this: ISelectQueryBuilder<JobModel[]> & JobQueryScopes) {
    return this.whereIn('Status', JOB_TERMINAL_STATUSES);
  }

  /** Jobs still in flight ( created / executing / retrying ). */
  public active(this: ISelectQueryBuilder<JobModel[]> & JobQueryScopes) {
    return this.whereIn('Status', JOB_ACTIVE_STATUSES);
  }

  /** Jobs created before the given moment ( row age ). */
  public olderThan(this: ISelectQueryBuilder<JobModel[]> & JobQueryScopes, date: DateTime) {
    return this.where('CreatedAt', '<', date);
  }

  /** Jobs finished before the given moment. */
  public finishedBefore(this: ISelectQueryBuilder<JobModel[]> & JobQueryScopes, date: DateTime) {
    return this.where('FinishedAt', '<', date);
  }
}

/**
 * Tracks a dispatched job: its status, progress, result / error and timing.
 * One row per emitted job, keyed by the unique {@link JobModel.JobId}.
 */
@Connection('queue')
@Model('queue_jobs')
export class JobModel<T = unknown> extends ModelBase {
  public static readonly _queryScopes: JobQueryScopes = new JobQueryScopes();

  @Primary()
  public Id: number;

  public JobId: string;

  public Name: string;

  /**
   * The job's successful result. Failures are recorded in {@link JobModel.LastError},
   * so this holds only the actual output.
   */
  @Json()
  public Result: T;

  public Status: JobStatus;

  public Progress: number;

  /**
   * Optional human-facing progress phase (e.g. `loading`, `rendering`), set by
   * jobs that report richer progress than a bare percentage. Nullable.
   */
  public Phase: string;

  /**
   * Optional human-facing progress message accompanying {@link Phase}. Nullable.
   */
  public Message: string;

  /**
   * Number of times job execution has been attempted. Incremented on every failed run.
   * Once it exceeds {@link JobModel.MaxAttempts} the job is marked as `dead`.
   */
  public Attempt: number;

  /**
   * Configured retry limit for the job ( the job's RetryCount at dispatch time ).
   * Lets consumers report progress as `Attempt / MaxAttempts`.
   */
  public MaxAttempts: number;

  /**
   * Last error message when the job failed or was retried. Kept separate from Result.
   */
  public LastError: string;

  public Connection: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @UpdatedAt()
  public UpdatedAt: DateTime;

  @DT()
  public ExecutedAt: DateTime;

  @DT()
  public FinishedAt: DateTime;
}
