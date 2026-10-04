import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('authn_audit')
export class AuthnAudit extends ModelBase<AuthnAudit> {
  @Primary()
  public id: string;

  @DT()
  public at: DateTime;

  public type: string;

  public outcome: string;

  public identity?: string | null;

  public actor?: string | null;

  public strategy?: string | null;

  public reason?: string | null;

  public ip?: string | null;

  public user_agent?: string | null;

  public session?: string | null;

  /** JSON text. */
  public data?: string | null;
}
