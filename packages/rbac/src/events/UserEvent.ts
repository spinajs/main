import { QueueEvent, Event } from '@spinajs/queue';
import { User } from '../index.js';

@Event()
export class UserEvent extends QueueEvent {
  public UserUUID: string;

  constructor(user: User) {
    super();

    this.UserUUID = user.Uuid;
  }
}
