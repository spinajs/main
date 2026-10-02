import { QueueEvent, Event } from '@spinajs/queue';
import { AccessToken } from '../models/AccessToken.js';

@Event()
export class AccessTokenEvent extends QueueEvent {
  /**
   * Public token identifier. Never the token material.
   */
  public TokenUuid: string;

  constructor(token: AccessToken) {
    super();
    this.TokenUuid = token.Uuid;
  }
}
