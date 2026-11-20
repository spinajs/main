import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';
import { Filterable } from '../../src/decorators.js';

@Connection('default')
@Model('like_row')
export class LikeRow extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(['like', 'b-like', 'e-like'])
  public Name: string;
}
