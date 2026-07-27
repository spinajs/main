/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, HasMany, OrphanPolicy, Relation } from '@spinajs/orm';

@Connection('sqlite')
@Model('integration_order_item')
export class IntegrationOrderItem extends ModelBase {
  @Primary()
  public Id: number;

  public Sku: string;

  public order_id: number;
}

@Connection('sqlite')
@Model('integration_order')
export class IntegrationOrder extends ModelBase {
  @Primary()
  public Id: number;

  public Total: number;

  @HasMany(IntegrationOrderItem, { foreignKey: 'order_id', primaryKey: 'Id', orphan: OrphanPolicy.Delete })
  public Items: Relation<IntegrationOrderItem, IntegrationOrder>;
}
