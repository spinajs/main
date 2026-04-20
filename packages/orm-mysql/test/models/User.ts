import { ModelBase, Primary, CreatedAt, Connection, Model, HasMany } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { UserMetadata } from './UserMetadata.js';

@Connection('mysql')
@Model('user_test')
export class User extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Password: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @HasMany(UserMetadata, { foreignKey: 'UserId' })
  public Metadata: UserMetadata[];
}
