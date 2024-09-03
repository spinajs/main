import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';
import { DateTime } from 'luxon';

/**
 * Reminder that password will expire soon
 */
@Event()
export class UserPasswordShouldChange extends UserEvent {
    constructor(public user : User, public expiration : DateTime){
        super(user);
    }
}
