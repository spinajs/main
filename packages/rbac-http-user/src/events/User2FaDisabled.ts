import { Event } from '@spinajs/queue';
import { UserEvent } from '@spinajs/rbac';

@Event()
export class User2FaDisabled extends UserEvent {}
