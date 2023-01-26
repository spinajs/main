import { Connection, Primary, Model } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';

@Connection('sqlite')
@Model('TestTable2')
// @ts-ignore
export class RawModel extends ModelBase {
  @Primary()
  public Id: number;

  public Bar: string;
}
