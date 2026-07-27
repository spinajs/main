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

  // The legacy `ManyToManyRelationList.update()` path instantiates the junction model and
  // finds its two sides by `relation.TargetModel === owner/target.constructor`, so both must
  // be declared here. `SubjectExecutor` does not need them — it writes junction rows
  // column-first — but relation.sync()/update() do.
  //
  // Named by string to avoid an import cycle; Orm.resolve() binds them by class name.
  @BelongsTo('UowOrder', 'order_id', 'Id')
  public Order: SingleRelation<UowOrder>;

  @BelongsTo('UowTag', 'tag_id', 'Id')
  public Tag: SingleRelation<UowTag>;
}
