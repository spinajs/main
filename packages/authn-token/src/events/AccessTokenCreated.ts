import { Event } from '@spinajs/queue';
import { AccessTokenEvent } from './AccessTokenEvent.js';

@Event()
export class AccessTokenCreated extends AccessTokenEvent {}
