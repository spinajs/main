/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('uow_tag')
export class UowTag extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}
