import { Primary, Connection, Model, ModelBase, BelongsTo, HasMany, Relation, SingleRelation, Sortable } from '@spinajs/orm';
import { Belongs } from './Belongs.js';
import { Test2 } from './Test2.js';

@Connection('default')
@Model('sorted')
export class Sorted extends ModelBase<Sorted> {
  @Primary()
  @Sortable()
  public Id: number;

  @Sortable()
  public Name: string;

  public Secret: string;

  @BelongsTo(Belongs)
  public Belongs: SingleRelation<Belongs>;

  @HasMany(Test2, {
    foreignKey: 'test_id',
    primaryKey: 'Id',
  })
  public TestsTwos: Relation<Test2, Sorted>;
}
