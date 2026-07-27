import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('sqlite')
@Model('composite_child')
export class CompositeChild extends ModelBase {
  @Primary()
  public Id: number;

  public tenant_id: number;

  public Val: string;
}
