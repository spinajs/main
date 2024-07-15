import { ModelBase, Primary, Connection, Model, Relation, BelongsTo, HasMany, SingleRelation} from '@spinajs/orm';
import { LocationMetadata } from './LocationMetadata.js';
import { LocationNetwork } from './LocationNetwork.js';

@Connection('sqlite')
@Model('location')
export class Location extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @BelongsTo(LocationNetwork,"Network_id")
  public Network : SingleRelation<LocationNetwork>;

  @HasMany(LocationMetadata)
  public Metadata : Relation<LocationMetadata, Location>;
}
