import { Connection, ModelBase, Model, Primary, BelongsTo } from '@spinajs/orm';
import { RelationModel3 } from './RelationModel3';

@Connection('sqlite')
@Model('RelationTable2')
export class RelationModel2 extends ModelBase {
  @Primary()
  public Id: number;

  public RelationProperty: string;

  @BelongsTo()
  public Relation3: RelationModel3;
}
