import { ModelBase, Primary, CreatedAt, Connection, Model } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('mysql')
@Model('user_test')
export class User extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Password: string;

  @CreatedAt()
  public CreatedAt: DateTime;
}
