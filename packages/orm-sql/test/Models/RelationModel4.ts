import { Connection, ModelBase, Model, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('RelationTable4')
export class RelationModel4 extends ModelBase {
  @Primary()
  public Id: number;

  public Model4Property: string;
}
