import { Connection, ModelBase, Model, Primary, BelongsTo,SingleRelation } from '@spinajs/orm';
import type { Model3 } from './Model3.js';

@Connection('sqlite')
@Model('TestTable4')
export class Model4 extends ModelBase {
  @Primary()
  public Id: number;

  public Bar: number;

  @BelongsTo('Model3')
  public Owner: SingleRelation<Model3>;
}
