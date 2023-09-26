import { Connection, Primary, Model, HasMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Relation } from '../../../src/relation-objects.js';
import { ModelNested3 } from './ModelNested3.js';

@Connection('sqlite')
@Model('ModelNested2')
// @ts-ignore
export class ModelNested2 extends ModelBase {
  @Primary()
  public Id: number;

  public Property2: string;

  @HasMany(ModelNested3, {
    foreignKey: 'rel_2',
  })
  public HasMany2: Relation<ModelNested3, ModelNested2>;
}
