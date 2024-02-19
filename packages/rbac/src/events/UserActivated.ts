import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';

@Event()
export class UserActivated extends UserEvent {

  public UserUUID: string;

  constructor(user: User) {
    super(user);

    this.UserUUID = user.Uuid;
  }
}
