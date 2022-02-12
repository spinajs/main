import { Connection, Primary, Model } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';

@Connection('sqlite')
@Model('Discrimination')
// @ts-ignore
export class ModelDisc1 extends ModelBase {
  @Primary()
  public Id: number;
}
