import { ModelBase, Primary, Connection, Model, CreatedAt } from '@spinajs/orm';

@Connection('sqlite')
@Model('test_model')
export class TestModel extends ModelBase {
  @Primary()
  public Id: number;

  @CreatedAt()
  public CreatedAt: Date;
}
