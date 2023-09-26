import { Connection, Primary, Model, BelongsTo, Recursive } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { SingleRelation } from '../../../src/relation-objects.js';

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
