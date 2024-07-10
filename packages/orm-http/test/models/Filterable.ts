import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';
import { Filterable } from '../../src/decorators.js';

@Connection('default')
@Model('filterable')
export class FilterableModel extends ModelBase {
  @Primary()
  public Id: number;

  @Filterable(["eq", "like"])
  public Text: string;

  @Filterable(["eq", "gt", "lt"])
  public Number : number;
}


