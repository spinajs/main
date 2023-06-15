import { ModelBase, Primary, Connection, Model, CreatedAt, HasMany, Relation, BelongsTo, SingleRelation} from '@spinajs/orm';
import { DateTime } from 'luxon';
import { TestMany } from './TestMany.js';
import { TestModelOwner } from './TestModelOwner.js';

@Connection('sqlite')
@Model('test_model')
export class TestModel extends ModelBase {
  @Primary()
  public Id: number;

  @CreatedAt()
  public CreatedAt: DateTime;

  @HasMany(TestMany)
  public Many: Relation<TestMany, TestModel>;

  @BelongsTo(TestModelOwner)
  public Owner: SingleRelation<TestModelOwner>;
}
