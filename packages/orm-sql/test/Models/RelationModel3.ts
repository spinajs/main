import { Connection, ModelBase, Model, Primary, HasManyToMany } from '@spinajs/orm';
import { RelationModel4 } from './RelationModel4.js';
import { JoinModel } from './JoinModel.js';

@Connection('sqlite')
@Model('RelationTable3')
export class RelationModel3 extends ModelBase {
  @Primary()
  public Id: number;

  public RelationProperty3: string;

  @HasManyToMany(JoinModel, RelationModel4, {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'target_id',
    junctionModelSourcePk: 'owner_id',
  })
  public Models: RelationModel4[];
}
