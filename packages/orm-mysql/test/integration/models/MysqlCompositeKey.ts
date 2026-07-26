import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mysql')
@Model('mysql_composite_key')
export class MysqlCompositeKey extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;

  public Name: string;
}
