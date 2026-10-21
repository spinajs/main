import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** An issued WebAuthn challenge until it is taken or purged. */
@Connection('default')
@Model('authn_webauthn_challenge')
export class AuthnWebauthnChallenge extends ModelBase<AuthnWebauthnChallenge> {
  @Primary({ generated: 'assigned' })
  public id: string;

  public challenge: string;

  public purpose: string;

  /** `<type>:<id>`, or null for a login challenge. */
  public identity?: string | null;

  @DT()
  public expires_at: DateTime;
}
