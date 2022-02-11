import { Connection, ModelBase, Model, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('TestTable2')
export class Model2 extends ModelBase {
  @Primary()
  public Id: number;

  public Far: string;

  public Bar: string;
}
