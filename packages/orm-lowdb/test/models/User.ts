import { ModelBase, CreatedAt, Connection, Model } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('lowdb')
@Model('users')
export class User extends ModelBase {
  public Id: number;

  public Name: string;

  public Password: string;

  @CreatedAt()
  public CreatedAt: DateTime;
}
