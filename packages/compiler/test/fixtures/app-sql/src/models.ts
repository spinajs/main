import { Model, ModelBase, Primary } from '@spinajs/orm';

@Model('accounts', { columns: 'exhaustive' })
export class Account extends ModelBase<Account> {
  @Primary() public Id: number;
  public Email: string;
}
