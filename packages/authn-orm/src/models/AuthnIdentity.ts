import { Bool, Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** A link from an external subject to an identity (design §22.16). */
@Connection('default')
@Model('authn_identity')
export class AuthnIdentity extends ModelBase<AuthnIdentity> {
  @Primary()
  public id: string;

  public identity_type: string;

  public identity_id: string;

  public provider: string;

  public subject: string;

  public email?: string | null;

  @Bool()
  public email_verified: boolean;

  public attributes?: string | null;

  @DT()
  public linked_at: DateTime;

  // Optional rather than `| null`: @DT() rejects the union, whose design type is Object.
  @DT()
  public last_used_at?: DateTime;
}
