import { ModelBase, Primary, Connection, Model} from '@spinajs/orm';

@Connection('sqlite')
@Model('location_network')
export class LocationNetwork extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
