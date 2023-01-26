import { Connection, Primary, Model } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';

@Connection('sqlite')
@Model('Discrimination')
// @ts-ignore
export class ModelDisc1 extends ModelBase {
  @Primary()
  public Id: number;
}
