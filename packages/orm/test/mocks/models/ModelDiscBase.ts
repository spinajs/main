import { Connection, Primary, Model, DiscriminationMap } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';
import { ModelDisc1 } from './ModelDisc1';
import { ModelDisc2 } from './ModelDisc2';

@Connection('sqlite')
@Model('Discrimination')
@DiscriminationMap('disc_key', [
  { Key: 'base', Value: ModelDiscBase },
  { Key: 'one', Value: ModelDisc1 },
  { Key: 'two', Value: ModelDisc2 },
])
// @ts-ignore
export class ModelDiscBase extends ModelBase {
  @Primary()
  public Id: number;

  public Value: string;
}
