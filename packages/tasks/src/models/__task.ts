import { ModelBase, Connection, Model, Primary, DateTime as DT } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('__tasks')
export class __task extends ModelBase {
  @Primary()
  public Id: number;

  /**
   * Task name
   */
  public Name: string;

  /**
   * Task description
   */
  public Description : string;

  /**
   * Is running or stopped
   */
  public State: 'running' | 'stopped';

  @DT()
  /**
   * Lat task run time at
   */
  public LastRunAt: DateTime;
}
