/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

@Connection('sqlite')
@Model('uow_strict_item')
export class UowStrictItem extends ModelBase {
  @Primary()
  public Id: number;

  public Sku: string;

  /** NOT NULL in the schema on purpose — drives the nullify -> delete orphan fallback. */
  public order_id: number;
}
