import { Connection, Primary, Model } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';

@Connection('sqlite')
@Model('ModelNested3')
// @ts-ignore
export class ModelNested3 extends ModelBase {
  @Primary()
  public Id: number;

  public Property3: string;
}
