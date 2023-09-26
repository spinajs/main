import { Connection, Primary, Model, BelongsTo } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { SingleRelation } from '../../../src/relation-objects.js';
import { RelationModel2 } from './RelationModel2.js';

@Connection('sqlite')
@Model('TestTableRelation1')
// @ts-ignore
export class RelationModel1 extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo(RelationModel2, 'OwnerId', 'Id')
  public Owner: SingleRelation<RelationModel2>;

  public Property1: string;
}
