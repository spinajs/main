import { ModelBase, Primary, Connection, Model, CreatedAt, HasMany, Relation } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { TestMany } from './TestMany.js';

@Connection('sqlite')
@Model('test_model')
export class TestModel extends ModelBase {
  @Primary()
  public Id: number;

  @CreatedAt()
  public CreatedAt: DateTime;

  @HasMany(TestMany)
  public Many: Relation<TestMany, TestModel>;
}
