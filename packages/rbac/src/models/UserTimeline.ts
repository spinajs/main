import { BelongsTo, Connection, CreatedAt, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { DateTime } from 'luxon';
import type { User } from './User';

/**
 * Timeline table for storing user actions / interactions
 * eg. login attempts, failed logins, resource deletions, alterations etc.
 */
@Connection('default')
@Model('user_timeline')
export class UserTimeline extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo('User')
  public User: SingleRelation<User>;

  public Action: string;

  public Data: string;

  /**
   * If action is performed on some kind of resource
   * Here is stored this rerource identifier or primary key in db
   */
  public ResourceId: number;

  public asNumber() {
    return parseInt(this.Data, 10);
  }

  public asFloat() {
    return parseFloat(this.Data);
  }

  public asJsonObject<T = {}>() {
    return JSON.parse(this.Data) as T;
  }

  @CreatedAt()
  public CreatedAt: DateTime;
}
