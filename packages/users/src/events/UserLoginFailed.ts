import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';

@Event()
export class UserLoginFailed extends UserEvent {
  constructor(user: User, public Error: Error) {
    super(user);
  }
}
