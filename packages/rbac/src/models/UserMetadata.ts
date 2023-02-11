import { BelongsTo, Connection, Model, ModelBase, Primary, SingleRelation, UniversalConverter } from '@spinajs/orm';
import _ from 'lodash';
import type { User } from './User.js';

@Connection('default')
@Model('users_metadata')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;

  public Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';

  @UniversalConverter('Type')
  public Value: any;

  @BelongsTo('User')
  public User: SingleRelation<User>;
}
