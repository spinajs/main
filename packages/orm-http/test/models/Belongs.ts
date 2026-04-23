import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';
import { Filterable } from '../../src/decorators.js';

@Connection('default')
@Model('belongs')
export class Belongs extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(["eq", "like"])
  public Text: string;
}
