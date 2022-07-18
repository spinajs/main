import { ModelBase, Primary, Connection, Model, CreatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('mssql')
@Model('test_model')
export class TestModel extends ModelBase {
  @Primary()
  public Id: number;

  @CreatedAt()
  public CreatedAt: DateTime;
}
