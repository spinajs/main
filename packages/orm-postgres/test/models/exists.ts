import { BelongsTo, Connection, HasMany, HasManyToMany, Model, ModelBase, Primary, Relation, SingleRelation, _prepareColumnDesc, extractDecoratorPropertyDescriptor } from '@spinajs/orm';

// FakePostgresDriver reports no table info, and WhereStatement refuses a column the
// descriptor does not know (`whereNotNull` on the belongsTo FK).
function Column() {
  return extractDecoratorPropertyDescriptor((model, _target, propertyKey) => {
    model.Columns.push(_prepareColumnDesc({ Name: propertyKey }));
  });
}

@Connection('postgres')
@Model('account')
export class ExistsAccount extends ModelBase {
  @Primary()
  public id: number;
}

@Connection('postgres')
@Model('note')
export class ExistsNote extends ModelBase {
  @Primary()
  public id: number;

  public item_id: number;
}

@Connection('postgres')
@Model('tag')
export class ExistsTag extends ModelBase {
  @Primary()
  public id: number;
}

@Connection('postgres')
@Model('item_tag')
export class ExistsItemTag extends ModelBase {
  @Primary()
  public id: number;

  public item_id: number;

  public tag_id: number;
}

@Connection('postgres')
@Model('model')
export class ExistsItem extends ModelBase {
  @Primary()
  public id: number;

  @Column()
  public user_id: number;

  @BelongsTo(ExistsAccount, 'user_id', 'id')
  public Owner: SingleRelation<ExistsAccount>;

  @HasMany(ExistsNote, { foreignKey: 'item_id' })
  public Notes: Relation<ExistsNote, ExistsItem>;

  @HasManyToMany(ExistsItemTag, ExistsTag, {
    targetModelPKey: 'id',
    sourceModelPKey: 'id',
    junctionModelTargetPk: 'tag_id',
    junctionModelSourcePk: 'item_id',
  })
  public Tags: ExistsTag[];
}
