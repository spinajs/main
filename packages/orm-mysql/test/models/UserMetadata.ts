import { ModelBase, Primary, CreatedAt, Connection, Model } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('mysql-2')
@Model('user_metadata')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public UserId: number;

  public Key: string;

  public Value: string;

  @CreatedAt()
  public CreatedAt: DateTime;

 
}
