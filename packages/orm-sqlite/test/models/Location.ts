import { ModelBase, Primary, Connection, Model, Relation, BelongsTo} from '@spinajs/orm';
import { LocationNetwork } from './LocationNetwork.js';

@Connection('sqlite')
@Model('location')
export class Location extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @BelongsTo(LocationNetwork,"Network_id")
  public Network : Relation<LocationNetwork, Location>;
}
