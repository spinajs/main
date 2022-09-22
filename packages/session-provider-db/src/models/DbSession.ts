import { ModelBase, Primary, Connection, Model, CreatedAt, DateTime as DT } from '@spinajs/orm';
import { DateTime } from 'luxon';
@Connection('session-provider-connection')
@Model('user_sessions')
export class DbSession extends ModelBase {
  @Primary()
  public SessionId: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @DT()
  public Expiration: DateTime;

  public Data: string;
}
