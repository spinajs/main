import { Connection, Primary, Model, Uuid } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';

@Connection('sqlite')
@Model('TestTable6')
// @ts-ignore
export class Model6 extends ModelBase {
  @Primary()
  @Uuid()
  public Id: number;

  public Property6: string;
}
