/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('uow_order_tag')
export class UowOrderTag extends ModelBase {
  @Primary()
  public Id: number;

  public order_id: number;

  public tag_id: number;
}
