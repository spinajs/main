import { Connection, Primary, Model, DiscriminationMap } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { ModelDisc1 } from './ModelDisc1.js';
import { ModelDisc2 } from './ModelDisc2.js';

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
