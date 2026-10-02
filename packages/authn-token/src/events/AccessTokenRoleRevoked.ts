import { Event } from '@spinajs/queue';
import { AccessToken } from '../models/AccessToken.js';
import { AccessTokenEvent } from './AccessTokenEvent.js';

@Event()
export class AccessTokenRoleRevoked extends AccessTokenEvent {
  constructor(token: AccessToken, public Role: string) {
    super(token);
  }
}
