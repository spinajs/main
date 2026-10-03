import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** A row of authn_nonce (design §22.16; the table comes with authn-orm's AuthnInitial migration). */
@Connection('default')
@Model('authn_nonce')
export class AuthnNonce extends ModelBase<AuthnNonce> {
  @Primary()
  public k: string;

  @DT()
  public expires_at: DateTime;
}
