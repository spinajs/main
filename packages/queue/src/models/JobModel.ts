import { DateTime } from 'luxon';
import { ModelBase, Connection, Model, Json, CreatedAt, DateTime as DT, Primary } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 */
@Connection('queue')
@Model('queue_jobs')
export class JobModel<T> extends ModelBase {
  @Primary()
  public Id: number;

  public JobId: string;

  public Name: string;

  @Json()
  public Result: T;

  public Status: 'error' | 'success' | 'created' | 'executing' | 'retrying' | 'dead';

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
   * Once it exceeds the job's RetryCount the job is marked as `dead`.
   */
  public Attempt: number;

  public Connection: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @DT()
  public ExecutedAt: DateTime;

  @DT()
  public FinishedAt: DateTime;
}
