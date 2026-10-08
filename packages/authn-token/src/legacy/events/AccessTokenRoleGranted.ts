import { Event } from '@spinajs/queue';
import { AccessToken } from '../../models/AccessToken.js';
import { AccessTokenEvent } from './AccessTokenEvent.js';

/** @deprecated 2.x API; use TokenService. R1 removes it. */
@Event()
export class AccessTokenRoleGranted extends AccessTokenEvent {
  constructor(token: AccessToken, public Role: string) {
    super(token);
  }
}
