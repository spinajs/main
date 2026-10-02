import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';

/**
 * User password expired
 */
@Event()
export class UserPasswordExpired extends UserEvent {
}
