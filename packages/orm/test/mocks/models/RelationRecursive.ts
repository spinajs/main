import { Connection, Primary, Model, BelongsTo, Recursive } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';

@Connection('sqlite')
@Model('RelationRecursive')
// @ts-ignore
export class RelationRecursive extends ModelBase {
  @Primary()
  public Id: number;

  @Recursive()
  @BelongsTo()
  public Parent: RelationRecursive;

  public Value: string;
}
