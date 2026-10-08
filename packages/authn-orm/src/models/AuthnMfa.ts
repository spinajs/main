import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** One MFA step of an identity; the primary key is (identity, step). */
@Connection('default')
@Model('authn_mfa')
export class AuthnMfa extends ModelBase<AuthnMfa> {
  @Primary()
  public identity: string;

  @Primary()
  public step: string;

  public secret_enc: string;

  public key_id: string;

  // Optional rather than `| null`: @DT() rejects the union, whose design type is Object.
  @DT()
  public confirmed_at?: DateTime;

  /** Postgres returns bigint as a string. */
  public last_step?: number | string | null;

  @DT()
  public created_at: DateTime;
}
