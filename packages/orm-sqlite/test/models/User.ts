import { ModelBase, Primary, CreatedAt, Connection, Model, DateTime as DT } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('sqlite')
@Model('user')
export class User extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Password: string;

  public IsActive: boolean;

  @CreatedAt()
  public CreatedAt: DateTime;

  @DT()
  public DateTime: DateTime;
}
