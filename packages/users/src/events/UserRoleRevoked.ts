import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';

@Event()
export class UserRoleRevoked extends UserEvent {
  constructor(public user: User, public Role: string) {
    super(user);
  }
}
