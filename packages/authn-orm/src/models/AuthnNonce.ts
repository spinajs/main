import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('authn_nonce')
export class AuthnNonceModel extends ModelBase<AuthnNonceModel> {
  @Primary()
  public k: string;

  @DT()
  public expires_at: DateTime;
}
