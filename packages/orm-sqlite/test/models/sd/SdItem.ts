/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, SoftDelete } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('sqlite')
@Model('sd_item')
export class SdItem extends ModelBase {
  @Primary()
  public Id: number;

  public Val: string;

  public owner_id: number;

  @SoftDelete()
  public DeletedAt: DateTime;
}
