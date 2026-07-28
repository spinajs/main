import { Connection, ModelBase, Model, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';
import { RelationModel2 } from './RelationModel2.js';
import { RelationModel3 } from './RelationModel3.js';

@Connection('sqlite')
@Model('RelationTable')
export class RelationModel extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo(RelationModel2)
  public Relation: SingleRelation<RelationModel2>;

  @BelongsTo(RelationModel2, 'fK_Id', 'pK_Id')
  public Relation2: SingleRelation<RelationModel2>;

  /**
   * Owner group, whose own membership is a many-to-many. Reproduces the shape of a model
   * whose ownership lives two relations away (yourscreen's ContentEntries -> EntriesGroup
   * -> Owners), which is what nested `whereExist` across a belongsTo has to support.
   */
  @BelongsTo(RelationModel3, 'group_id', 'Id')
  public Group: SingleRelation<RelationModel3>;
}
