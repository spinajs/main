import { BelongsTo, Connection, CreatedAt, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { DateTime } from 'luxon';
import type { User } from './User';

/**
 * Timeline table for storing user actions / interactions
 * eg. login attempts, failed logins, resource deletions, alterations etc.
 */
@Connection('default')
@Model('user_actions')
export class UserAction extends ModelBase<UserAction> {
  @Primary()
  public Id: number;

  @BelongsTo('User')
  public User: SingleRelation<User>;

  public Action: string;

  public Data: string;

  /**
   * True if this timeline event is persistent
   * eg. we clear out login attempts older than 5 days
   * but we want to save for eg. events related to payments
   */
  public Persistent: boolean;

  /**
   * If action is performed on some kind of resource
   * Here is stored this resource identifier or primary key in db
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
