import { Connection, ModelBase, Model, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';
import { RelationModel2 } from './RelationModel2';

@Connection('sqlite')
@Model('RelationTable')
export class RelationModel extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo(RelationModel2)
  public Relation: SingleRelation<RelationModel2>;

  @BelongsTo(RelationModel2, 'fK_Id', 'pK_Id')
  public Relation2: SingleRelation<RelationModel2>;
}
