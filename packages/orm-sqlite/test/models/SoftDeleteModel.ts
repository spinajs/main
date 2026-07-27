import { ModelBase, Primary, Connection, Model, SoftDelete } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('sqlite')
@Model('soft_delete_test')
export class SoftDeleteModel extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @SoftDelete()
  public DeletedAt: DateTime;
}
