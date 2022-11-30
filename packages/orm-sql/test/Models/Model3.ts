import { Model4 } from './../../../orm/test/mocks/models/Model4';
import { Connection, ModelBase, Model, Primary, HasMany, Relation } from '@spinajs/orm';

@Connection('sqlite')
@Model('TestTable3')
export class Model3 extends ModelBase {
  @Primary()
  public Id: number;

  @HasMany(Model4)
  public Model4s: Relation<Model4>;
}
