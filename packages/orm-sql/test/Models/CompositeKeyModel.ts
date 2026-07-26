import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('composite_table')
export class CompositeKeyModel extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;

  public Name: string;
}
