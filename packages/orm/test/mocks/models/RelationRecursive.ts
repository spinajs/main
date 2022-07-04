import { Connection, Primary, Model, BelongsTo, Recursive } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';
import { SingleRelation } from '../../../src/relations';

@Connection('sqlite')
@Model('RelationRecursive')
// @ts-ignore
export class RelationRecursive extends ModelBase {
  @Primary()
  public Id: number;

  @Recursive()
  @BelongsTo(RelationRecursive)
  public Parent: SingleRelation<RelationRecursive>;

  public Value: string;
}
