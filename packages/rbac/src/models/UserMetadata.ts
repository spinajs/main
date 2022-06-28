import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('default')
@Model('user_metadatas')
export class UserMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;

  public Value: string;
}
