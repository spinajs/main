/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('sqlite')
@Model('uow_cycle_a')
export class UowCycleA extends ModelBase {
  @Primary()
  public Id: number;

  public b_id: number;

  @BelongsTo('UowCycleB', 'b_id', 'Id')
  public B: SingleRelation<UowCycleB>;
}

@Connection('sqlite')
@Model('uow_cycle_b')
export class UowCycleB extends ModelBase {
  @Primary()
  public Id: number;

  public a_id: number;

  @BelongsTo('UowCycleA', 'a_id', 'Id')
  public A: SingleRelation<UowCycleA>;
}
