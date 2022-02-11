import { Connection, ModelBase, Model, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('JoinTable')
export class JoinModel extends ModelBase {
  @Primary()
  public Id: number;

  public owner_id: number;

  public target_id: number;
}
