import { Connection, ModelBase, Model, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('TestTable1')
export class Model1 extends ModelBase {
  @Primary()
  public Id: number;

  public Bar: string;
}
