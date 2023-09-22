import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('offer')
export class Offer extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
