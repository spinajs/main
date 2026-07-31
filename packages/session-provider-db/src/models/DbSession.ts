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
   * Declared as a string because that is what the WRITE path assigns:
   * `encodeSessionData` produces JSON text and a MySQL `json` column stores it
   * verbatim. What comes BACK depends on the driver - mysql2 parses a json
   * column into an object, sqlite returns the text - so the read path accepts
   * both. The declared type is deliberately not widened to `string | object`:
   * this model is exported, the object shape never escapes the provider, and
   * widening would force every consumer to narrow for a case it cannot observe.
   *
   * No `@Json()` decorator on purpose: the ORM's JsonValueConverter would
   * `JSON.stringify` the already-encoded string on write and double-encode
   * every session.
   */
  public Data: string;

  public UserId: number;
}
