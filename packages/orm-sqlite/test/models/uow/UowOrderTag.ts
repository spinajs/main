/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';
// Type-only: UowOrder imports this file as a value for its @HasManyToMany junction argument.
import type { UowOrder } from './UowOrder.js';
import type { UowTag } from './UowTag.js';

@Connection('sqlite')
@Model('uow_order_tag')
export class UowOrderTag extends ModelBase {
  @Primary()
  public Id: number;

  public order_id: number;

  public tag_id: number;

  public Note: string;

  // The lazy `ManyToManyRelationList.populate()` finds its sides by `relation.TargetModel`, so
  // both are declared here; the junction writes of save(), sync() and update() do not need them.
  //
  // Named by string to avoid an import cycle; Orm.resolve() binds them by class name.
  @BelongsTo('UowOrder', 'order_id', 'Id')
  public Order: SingleRelation<UowOrder>;

  @BelongsTo('UowTag', 'tag_id', 'Id')
  public Tag: SingleRelation<UowTag>;
}
