import { Connection, Primary, Model, HasMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Relation } from '../../../src/relation-objects.js';
import { ModelNested2 } from './ModelNested2.js';

@Connection('sqlite')
@Model('ModelNested1')
// @ts-ignore
export class ModelNested1 extends ModelBase {
  @Primary()
  public Id: number;

  public Property1: string;

  @HasMany(ModelNested2, {
    foreignKey: 'rel_1',
  })
  public HasMany1: Relation<ModelNested2, ModelNested1>;
}
