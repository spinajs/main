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

  public Status: 'error' | 'success' | 'created' | 'executing' | 'retrying' | 'dead-letter';

  public Progress: number;

  public Connection: string;

  /**
   * Number of retry attempts performed so far ( 0 on first execution ).
   */
  public RetryCount: number;

  /**
   * Last error message when the job failed or was retried.
   */
  public LastError: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @DT()
  public ExecutedAt: DateTime;

  @DT()
  public FinishedAt: DateTime;

  @DT()
  public DeadLetteredAt: DateTime;
}
