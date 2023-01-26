import { Connection, Primary, Model, BelongsTo, HasMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Model1 } from './Model1.js';
import { Relation, SingleRelation } from '../../../src/relations.js';
@Connection('sqlite')
@Model('TestTableRelation2')
// @ts-ignore
export class RelationModel2 extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo(Model1, 'OwnerId', 'Id')
  public Owner: SingleRelation<Model1>;

  public Property2: string;

  @HasMany(Model1, {
    foreignKey: 'RelId2',
  })
  public Many: Relation<Model1, RelationModel2>;
}
