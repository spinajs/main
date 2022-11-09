import { DateTime } from 'luxon';
import { ModelBase, Connection, Model, Json, CreatedAt, DateTime as DT, Primary } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
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

  public Status: 'error' | 'success' | 'created' | 'executing';

  public Progress: number;

  @CreatedAt()
  public CreatedAt: DateTime;

  @DT()
  public ExecutedAt: DateTime;

  @DT()
  public FinishedAt: DateTime;
}
