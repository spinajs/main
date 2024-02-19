import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';

@Event()
export class UserUnbanned extends UserEvent {}
