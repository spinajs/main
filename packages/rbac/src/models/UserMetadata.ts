import { BelongsTo, Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import type { User } from './User';

@Connection('default')
@Model('users_metadata')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;

  public Value: string;

  @BelongsTo('User')
  public User: User;
}
