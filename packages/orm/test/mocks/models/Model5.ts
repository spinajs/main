import { JunctionModel } from './JunctionModel.js';
import { Connection, Primary, Model, JunctionTable } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';

@Connection('sqlite')
@Model('TestTable5')
// @ts-ignore
export class Model5 extends ModelBase {
  @Primary()
  public Id: number;

  public Property5: string;

  @JunctionTable()
  public JunctionModelProps: JunctionModel;
}
