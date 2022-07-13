import { SingleRelation } from './../../../orm/src/relations';
import { ModelBase, Primary, Connection, Model, BelongsTo } from '@spinajs/orm';
import { TestModel } from './TestModel';

@Connection('sqlite')
@Model('test_owned')
export class TestOwned extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @BelongsTo(TestModel)
  public Owner: SingleRelation<TestModel>;
}
