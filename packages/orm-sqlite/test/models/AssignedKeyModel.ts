import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('assigned_key_model')
export class AssignedKeyModel extends ModelBase {
  @Primary({ generated: 'assigned' })
  public Code: string;

  public Name: string;
}
