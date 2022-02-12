import { Connection, Primary, Model, HasMany } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';
import { Relation } from '../../../src/relations';
import { ModelNested3 } from './ModelNested3';

@Connection('sqlite')
@Model('ModelNested2')
// @ts-ignore
export class ModelNested2 extends ModelBase {
  @Primary()
  public Id: number;

  public Property2: string;

  @HasMany(ModelNested3, 'rel_2')
  public HasMany2: Relation<ModelNested3>;
}
