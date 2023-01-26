import { Connection, Primary, Model, HasManyToMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Model5 } from './Model5.js';
import { JunctionModel } from './JunctionModel.js';
import { Relation } from '../../../src/relations.js';

@Connection('sqlite')
@Model('TestTable4')
// @ts-ignore
export class Model4 extends ModelBase {
  @Primary()
  public Id: number;

  public Property4: string;

  @HasManyToMany(JunctionModel, Model5)
  public ManyOwners: Relation<Model5, Model4>;
}
