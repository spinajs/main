import { ModelBase, Primary, Connection, Model, BelongsTo, HasMany, HasManyToMany, Relation, SingleRelation, Uuid } from '@spinajs/orm';

// Keys stored as 16-byte BLOBs: the value bound to the database differs from the one the model holds.

@Connection('sqlite')
@Model('uk_order_tag')
export class UkOrderTag extends ModelBase {
  @Primary()
  public Id: number;

  public order_id: number;

  @Uuid()
  public tag_id: string;

  @BelongsTo('UkOrder', 'order_id', 'Id')
  public Order: SingleRelation<UkOrder>;

  @BelongsTo('UkTag', 'tag_id', 'Id')
  public Tag: SingleRelation<UkTag>;
}

@Connection('sqlite')
@Model('uk_tag')
export class UkTag extends ModelBase {
  @Primary({ generated: 'assigned' })
  @Uuid()
  public Id: string;

  public Name: string;

  @HasMany('UkNote', { foreignKey: 'tag_id', primaryKey: 'Id' })
  public Notes: Relation<UkNote, UkTag>;

  @HasManyToMany(UkOrderTag, 'UkOrder', {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'order_id',
    junctionModelSourcePk: 'tag_id',
  })
  public Orders: Relation<UkOrder, UkTag>;
}

@Connection('sqlite')
@Model('uk_note')
export class UkNote extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;

  @Uuid()
  public tag_id: string;

  @BelongsTo(UkTag, 'tag_id', 'Id')
  public Tag: SingleRelation<UkTag>;
}

// The database generates the key (DEFAULT randomblob(16)), so save() reads it back raw through RETURNING.
@Connection('sqlite')
@Model('uk_gen_tag')
export class UkGenTag extends ModelBase {
  @Primary()
  @Uuid()
  public Id: string;

  public Name: string;

  @HasMany('UkGenNote', { foreignKey: 'tag_id', primaryKey: 'Id' })
  public Notes: Relation<UkGenNote, UkGenTag>;
}

@Connection('sqlite')
@Model('uk_gen_note')
export class UkGenNote extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;

  @Uuid()
  public tag_id: string;

  @BelongsTo(UkGenTag, 'tag_id', 'Id')
  public Tag: SingleRelation<UkGenTag>;
}

@Connection('sqlite')
@Model('uk_item')
export class UkItem extends ModelBase {
  @Primary({ generated: 'assigned' })
  @Uuid()
  public Id: string;

  public Name: string;

  public order_id: number;
}

@Connection('sqlite')
@Model('uk_order')
export class UkOrder extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(UkItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<UkItem, UkOrder>;

  @HasManyToMany(UkOrderTag, UkTag, {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'tag_id',
    junctionModelSourcePk: 'order_id',
  })
  public Tags: Relation<UkTag, UkOrder>;
}
