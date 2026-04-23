import { Primary, Connection, Model, ModelBase, BelongsTo, HasMany, Relation, SingleRelation } from '@spinajs/orm';
import { Filterable } from '../../src/decorators.js';
import { Belongs } from './Belongs.js';
import { Test2 } from './Test2.js';

@Connection('default')
@Model('filterable')
export class FilterableModel extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(["eq", "like"])
  public Text: string;

  @Filterable(["eq", "gt", "lt"])
  public Number: number;

  @BelongsTo(Belongs)
  public Belongs: SingleRelation<Belongs>;

  @HasMany(Test2, {
    foreignKey: 'test_id',
    primaryKey: 'Id',
  })
  public TestsTwos: Relation<Test2, FilterableModel>;
}


