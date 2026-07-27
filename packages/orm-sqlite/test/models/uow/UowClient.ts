/* eslint-disable prettier/prettier */
import { ModelBase, Primary, Connection, Model, HasMany, Relation } from '@spinajs/orm';
// Type-only: UowOrder declares `@BelongsTo(UowClient)` and so imports this file as a value.
// A value import back would close the cycle and throw
// `Cannot access 'UowOrder' before initialization` at decorator-evaluation time.
// The relation names its target as a string instead; Orm.resolve() binds it by class name.
import type { UowOrder } from './UowOrder.js';

@Connection('sqlite')
@Model('uow_client')
export class UowClient extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany('UowOrder', { foreignKey: 'client_id', primaryKey: 'Id' })
  public Orders: Relation<UowOrder, UowClient>;
}
