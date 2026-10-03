import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('authn_recovery_code')
export class AuthnRecoveryCode extends ModelBase<AuthnRecoveryCode> {
  @Primary()
  public id: string;

  public identity: string;

  /** Hex SHA-256 of the raw code. */
  public code_hash: string;

  // Optional rather than `| null`: @DT() rejects the union, whose design type is Object.
  @DT()
  public used_at?: DateTime;
}
