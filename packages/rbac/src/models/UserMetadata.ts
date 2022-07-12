import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('default')
@Model('users_metadata')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;

  public Value: string;
}
