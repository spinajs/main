import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('locationmeta')
export class LocationMetadata extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;
 
}
