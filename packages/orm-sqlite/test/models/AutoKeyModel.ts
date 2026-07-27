import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('auto_key_model')
export class AutoKeyModel extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
