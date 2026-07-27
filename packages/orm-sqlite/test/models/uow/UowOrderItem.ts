/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';
import { UowOrder } from './UowOrder.js';

@Connection('sqlite')
@Model('uow_order_item')
export class UowOrderItem extends ModelBase {
  @Primary()
  public Id: number;

  public Sku: string;

  public Qty: number;

  public order_id: number;

  @BelongsTo(UowOrder, 'order_id', 'Id')
  public Order: SingleRelation<UowOrder>;
}
