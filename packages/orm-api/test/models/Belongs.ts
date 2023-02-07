import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';

@Connection('default')
@Model('belongs')
export class Belongs extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;
}
