import { Connection, Primary, Model, HasMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { Relation } from '../../../src/relation-objects.js';
import { Model1 } from './Model1.js';

/**
 * Two HasMany relations pointing at the SAME target model — regression fixture: populating
 * one of them must not push rows into the other.
 */
@Connection('sqlite')
@Model('TestTableRelation2')
// @ts-ignore
export class DualRelationModel extends ModelBase {
  @Primary()
  public Id: number;

  @HasMany(Model1, {
    foreignKey: 'RelId2',
  })
  public Many: Relation<Model1, DualRelationModel>;

  @HasMany(Model1, {
    foreignKey: 'OwnerId',
  })
  public OtherMany: Relation<Model1, DualRelationModel>;
}
