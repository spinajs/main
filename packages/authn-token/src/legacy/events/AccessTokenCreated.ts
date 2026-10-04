import { Event } from '@spinajs/queue';
import { AccessTokenEvent } from './AccessTokenEvent.js';

/** @deprecated 2.x API; use TokenService. R1 removes it. */
@Event()
export class AccessTokenCreated extends AccessTokenEvent {}
