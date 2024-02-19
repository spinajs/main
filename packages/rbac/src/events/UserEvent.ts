import { QueueEvent, Event } from '@spinajs/queue';
import { User } from '../index.js';

@Event()
export class UserEvent extends QueueEvent {

    constructor(_user: User) {
        super();
    }
}