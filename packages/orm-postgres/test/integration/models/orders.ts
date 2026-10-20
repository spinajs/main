import { BelongsTo, Connection, HasMany, HasManyToMany, Model, ModelBase, OrphanPolicy, Primary, Relation, SingleRelation } from '@spinajs/orm';

@Connection('postgres')
@Model('pg_client')
export class PgClient extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('postgres')
@Model('pg_order_item')
export class PgOrderItem extends ModelBase {
  @Primary()
  public Id: number;

  public Sku: string;

  public order_id: number;
}

@Connection('postgres')
@Model('pg_tag')
export class PgTag extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('postgres')
@Model('pg_order_tag')
export class PgOrderTag extends ModelBase {
  @Primary()
  public Id: number;

  public order_id: number;

  public tag_id: number;

  public Note: string;

  // relation.sync()/update() find the two sides of a junction through these
  @BelongsTo('PgOrder', 'order_id', 'Id')
  public Order: SingleRelation<PgOrder>;

  @BelongsTo('PgTag', 'tag_id', 'Id')
  public Tag: SingleRelation<PgTag>;
}

@Connection('postgres')
@Model('pg_order')
export class PgOrder extends ModelBase {
  @Primary()
  public Id: number;

  public Total: number;

  public client_id: number;

  @BelongsTo(PgClient, 'client_id', 'Id')
  public Client: SingleRelation<PgClient>;

  @HasMany(PgOrderItem, { foreignKey: 'order_id', primaryKey: 'Id', orphan: OrphanPolicy.Delete })
  public Items: Relation<PgOrderItem, PgOrder>;

  @HasManyToMany(PgOrderTag, PgTag, {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'tag_id',
    junctionModelSourcePk: 'order_id',
  })
  public Tags: Relation<PgTag, PgOrder>;
}
