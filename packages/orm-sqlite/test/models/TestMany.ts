import { ModelBase, Primary, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';
import { TestModel } from './TestModel.js';

@Connection('sqlite')
@Model('test_many')
export class TestMany extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @BelongsTo("TestModel") 
  public TestModel: SingleRelation<TestModel>;
}
