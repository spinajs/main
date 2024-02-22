import { ModelBase, Primary, Connection, Model, Relation, HasMany, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('sqlite')
@Model('owned_by_owned_by_has_many_1')
export class owned_by_owned_by_has_many_1 extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;
 
}

@Connection('sqlite')
@Model('owned_by_has_many_1')
export class owned_by_has_many_1 extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  @BelongsTo(owned_by_owned_by_has_many_1)
  public File: SingleRelation<owned_by_owned_by_has_many_1>;

  @BelongsTo("has_many_1")
  public Has_Many_1: SingleRelation<has_many_1>;
}

@Connection('sqlite')
@Model('has_many_1')
export class has_many_1 extends ModelBase<has_many_1> {
  @Primary()
  public Id: number;

  public Val: string;

  @HasMany(owned_by_has_many_1)
  public Informations: Relation<owned_by_has_many_1, has_many_1>;
}
