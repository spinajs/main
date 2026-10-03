import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('authn_secret')
export class AuthnSecret extends ModelBase<AuthnSecret> {
  @Primary()
  public id: string;

  public identity: string;

  public purpose: string;

  /** Hex SHA-256 of the raw secret. */
  public secret_hash: string;

  @DT()
  public expires_at: DateTime;

  // Optional rather than `| null`: @DT() rejects the union, whose design type is Object.
  @DT()
  public used_at?: DateTime;

  @DT()
  public created_at: DateTime;
}
