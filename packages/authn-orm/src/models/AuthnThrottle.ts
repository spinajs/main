import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('authn_throttle')
export class AuthnThrottle extends ModelBase<AuthnThrottle> {
  @Primary()
  public k: string;

  public attempts: number;

  @DT()
  public last_attempt_at: DateTime;

  @DT()
  public next_allowed_at: DateTime;

  @DT()
  public updated_at: DateTime;
}
