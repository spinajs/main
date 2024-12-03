import { ModelBase, Connection, Model, Primary, CreatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('__task_history')
export class __task_history extends ModelBase {
  @Primary()
  public Id: number;

  /**
   * Task name
   */
  public TaskId: Number;

  /**
   * Task run result result
   */
  public Result : string;

  @CreatedAt()
  /**
   * Lat task run time at
   */
  public CreatedAt: DateTime;

  public Duration : number;
}
