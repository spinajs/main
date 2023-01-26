import { Connection, Primary, Model } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Model4 } from './Model4.js';
import { Model5 } from './Model5.js';

@Connection('sqlite')
@Model('JunctionTable')
// @ts-ignore
export class JunctionModel extends ModelBase {
  @Primary()
  public Id: number;

  public OwnerModel: Model4;

  public ForeignModel: Model5;

  public JoinProperty: string;
}
