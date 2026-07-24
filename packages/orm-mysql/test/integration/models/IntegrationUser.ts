import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('mysql')
@Model('integration_user')
export class IntegrationUser extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
