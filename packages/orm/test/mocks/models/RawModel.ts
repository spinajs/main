import { Connection, Primary, Model } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';

@Connection('sqlite')
@Model('TestTable2')
// @ts-ignore
export class RawModel extends ModelBase {
  @Primary()
  public Id: number;

  public Bar: string;
}
