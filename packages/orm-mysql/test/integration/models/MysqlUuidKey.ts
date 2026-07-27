import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mysql')
@Model('mysql_uuid_key')
export class MysqlUuidKey extends ModelBase {
  @Primary({ generated: 'uuid' })
  public Id: string;

  public Name: string;
}
