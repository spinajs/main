import { Primary, Connection, Model, ModelBase, BelongsTo, SingleRelation } from '@spinajs/orm';
import { User } from './User.js';

@Connection('default')
@Model('campaign')
export class Campaign extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public author: number;

  @BelongsTo(User, 'author')
  public Author: SingleRelation<User>;
}
