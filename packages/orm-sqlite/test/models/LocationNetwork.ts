import { ModelBase, Primary, Connection, Model, HasMany, Relation} from '@spinajs/orm';
import { LocationNetworkMetadata } from './LocationNetworkMetadata.js';

@Connection('sqlite')
@Model('location_network')
export class LocationNetwork extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  
  @HasMany(LocationNetworkMetadata, {
    foreignKey: "network_id"
  })
  public Metadata : Relation<LocationNetworkMetadata, LocationNetwork>;
}
