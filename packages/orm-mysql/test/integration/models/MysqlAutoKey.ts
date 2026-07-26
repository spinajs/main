import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mysql')
@Model('mysql_auto_key')
export class MysqlAutoKey extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
