/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, HasMany, OrphanPolicy, Relation, SingleRelation } from '@spinajs/orm';

@Connection('mysql')
@Model('uow_client')
export class IntegrationUowClient extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('mysql')
@Model('uow_order_item')
export class IntegrationUowOrderItem extends ModelBase {
  @Primary()
  public Id: number;

  public Sku: string;

  public order_id: number;
}

@Connection('mysql')
@Model('uow_order')
export class IntegrationUowOrder extends ModelBase {
  @Primary()
  public Id: number;

  public Total: number;

  public client_id: number;

  @BelongsTo(IntegrationUowClient, 'client_id', 'Id')
  public Client: SingleRelation<IntegrationUowClient>;

  @HasMany(IntegrationUowOrderItem, { foreignKey: 'order_id', primaryKey: 'Id', orphan: OrphanPolicy.Delete })
  public Items: Relation<IntegrationUowOrderItem, IntegrationUowOrder>;
}
