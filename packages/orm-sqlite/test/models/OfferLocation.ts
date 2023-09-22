import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('offer_location')
export class OfferLocation extends ModelBase {
  @Primary()
  public Id: number;
}
