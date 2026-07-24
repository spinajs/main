import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('integration_user')
export class IntegrationUser extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
