/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, BelongsTo, HasMany, Relation, SingleRelation } from '@spinajs/orm';

@Connection('sqlite')
@Model('uow_node')
export class UowNode extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public parent_id: number;

  @BelongsTo('UowNode', 'parent_id', 'Id')
  public Parent: SingleRelation<UowNode>;

  @HasMany('UowNode', { foreignKey: 'parent_id', primaryKey: 'Id' })
  public Children: Relation<UowNode, UowNode>;
}
