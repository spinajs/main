import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import type { DateTime } from 'luxon';

@Connection('default')
@Model('accounts')
export class Account extends ModelBase<Account> {
  @Primary()
  public Id: number;

  public Name: string;

  public Active: boolean;

  public Nickname?: string;

  public SeenAt?: DateTime;
}
