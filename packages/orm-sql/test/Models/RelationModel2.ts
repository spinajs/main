import { Connection, ModelBase, Model, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';
import { RelationModel3 } from './RelationModel3.js';

@Connection('sqlite')
@Model('RelationTable2')
export class RelationModel2 extends ModelBase {
  @Primary()
  public Id: number;

  public RelationProperty: string;

  @BelongsTo(RelationModel2)
  public Relation3: SingleRelation<RelationModel3>;
}
