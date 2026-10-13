import { QueueEvent, Event } from '@spinajs/queue';
import type { User } from '../models/User.js';

@Event()
export class UserEvent extends QueueEvent {
  public UserUUID: string;

  constructor(user: User) {
    super();

    this.UserUUID = user.Uuid;
  }
}
