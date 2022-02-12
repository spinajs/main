import { Connection, Primary, Model } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';

@Connection('sqlite')
@Model('ModelNested3')
// @ts-ignore
export class ModelNested3 extends ModelBase {
  @Primary()
  public Id: number;

  public Property3: string;
}
