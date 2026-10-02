import { Event } from '@spinajs/queue';
import { UserEvent } from '@spinajs/users';

@Event()
export class User2FaDisabled extends UserEvent {}
