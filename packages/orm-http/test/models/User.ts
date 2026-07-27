import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase {
  @Primary()
  public Id: number;

  public Uuid: string;
}
