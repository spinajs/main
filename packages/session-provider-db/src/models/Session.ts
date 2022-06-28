import { ModelBase, Primary, Connection, Model, CreatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('acl_sessions')
export class DbSession extends ModelBase {
  @Primary()
  public Id: number;

  public SessionId: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  public Expiration: DateTime;

  public Data: string;
}
