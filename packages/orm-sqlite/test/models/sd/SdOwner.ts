/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, HasMany, Relation } from '@spinajs/orm';
import type { SdItem } from './SdItem.js';

@Connection('sqlite')
@Model('sd_owner')
export class SdOwner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany('SdItem', { foreignKey: 'owner_id', primaryKey: 'Id' })
  public Items: Relation<SdItem, SdOwner>;
}
