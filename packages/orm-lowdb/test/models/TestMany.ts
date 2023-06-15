import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('test_many')
export class TestMany extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;
}
