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

  /**
   * Serialized session payload - see `encodeSessionData` / `decodeSessionData`.
   *
   * Declared as a string because that is what the write path stores and what a
   * `text` column returns. On a database whose column is MySQL `json` (created
   * by an in-between revision of the migration) mysql2 returns it already
   * parsed, so the read path normalizes before decoding.
   */
  public Data: string;

  public UserId: number;
}
