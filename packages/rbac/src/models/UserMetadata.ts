import { BelongsTo, Connection, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { DateTime } from 'luxon';
import type { User } from './User';

@Connection('default')
@Model('users_metadata')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;

  public Value: string;

  public asBoolean() {
    return this.Value.toLowerCase().trim() === 'true' || this.Value.trim() === '1' ? true : false;
  }

  public asNumber() {
    return parseInt(this.Value, 10);
  }

  public asFloat() {
    return parseFloat(this.Value);
  }

  public asJsonObject<T = {}>() {
    return JSON.parse(this.Value) as T;
  }

  public asISODate() {
    return DateTime.fromISO(this.Value);
  }

  @BelongsTo('User')
  public User: SingleRelation<User>;
}
