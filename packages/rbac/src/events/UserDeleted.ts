import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';

@Event()
export class UserDeleted extends UserEvent {}
