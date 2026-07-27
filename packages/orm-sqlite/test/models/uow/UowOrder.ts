/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, HasMany, HasManyToMany, OrphanPolicy, Relation, SingleRelation } from '@spinajs/orm';
import { UowClient } from './UowClient.js';
// Type-only for the same reason as in UowClient: UowOrderItem declares
// `@BelongsTo(UowOrder)` and imports this file as a value.
import type { UowOrderItem } from './UowOrderItem.js';
import { UowOrderTag } from './UowOrderTag.js';
import { UowStrictItem } from './UowStrictItem.js';
import { UowTag } from './UowTag.js';

@Connection('sqlite')
@Model('uow_order')
export class UowOrder extends ModelBase {
  @Primary()
  public Id: number;

  public Total: number;

  public client_id: number;

  @BelongsTo(UowClient, 'client_id', 'Id')
  public Client: SingleRelation<UowClient>;

  @HasMany('UowOrderItem', { foreignKey: 'order_id', primaryKey: 'Id', orphan: OrphanPolicy.Delete })
  public Items: Relation<UowOrderItem, UowOrder>;

  @HasMany(UowStrictItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public StrictItems: Relation<UowStrictItem, UowOrder>;

  @HasManyToMany(UowOrderTag, UowTag, {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'tag_id',
    junctionModelSourcePk: 'order_id',
  })
  public Tags: Relation<UowTag, UowOrder>;
}
