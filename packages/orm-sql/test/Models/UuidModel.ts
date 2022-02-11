import { Connection, ModelBase, Model, Primary, Uuid } from '@spinajs/orm';

@Connection('sqlite')
@Model('TestTable2')
export class UuidModel extends ModelBase {
  @Primary()
  @Uuid()
  public Id: string;

  public Far: string;

  public Bar: string;
}
