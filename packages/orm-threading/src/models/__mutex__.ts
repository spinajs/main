import { Model, Connection, ModelBase, Primary, CreatedAt, UpdatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('__mutex__')
export class __mutex__ extends ModelBase<__mutex__> {
  @Primary()
  public Name: string;

  public Tenant: string;

  public Locked: boolean;

  @CreatedAt()
  public Created_at: DateTime;

  @UpdatedAt()
  public Updated_at: DateTime;

  constructor(data: Partial<__mutex__>) {
    super({
      Created_at: DateTime.now(),
      Updated_at: DateTime.now(),
      ...data,
    });
  }
}
