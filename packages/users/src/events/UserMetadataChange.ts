import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';

@Event()
export class UserMetadataChange extends UserEvent {

    constructor(public user: User, public meta: { key : string, value: any}[]) {
        super(user);
      }

}
