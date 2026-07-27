import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('uuid_key_model')
export class UuidKeyModel extends ModelBase {
  @Primary({ generated: 'uuid' })
  public Id: string;

  public Name: string;
}
