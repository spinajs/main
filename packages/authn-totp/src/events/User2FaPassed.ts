import { Event } from '@spinajs/queue';
import { UserEvent } from '@spinajs/users';

@Event()
export class User2FaPassed extends UserEvent {}
