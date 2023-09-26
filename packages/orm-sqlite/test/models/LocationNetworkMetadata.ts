import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('locationnetworkmetadata')
export class LocationNetworkMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;
 
}
