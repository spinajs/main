import { ModelBase, Primary, Connection, Model, CreatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('sqlite')
@Model('test_model_owner')
export class TestModelOwner extends ModelBase {
  @Primary()
  public Id: number;

  @CreatedAt()
  public CreatedAt: DateTime;
}
