import { QueueEvent, Event } from '@spinajs/queue';
import { NewInstance } from '@spinajs/di';
import type { User } from '../models/User.js';

/**
 * `user` is optional because `QueueService.consume()` builds each delivered message with `DI.resolve(EventClass)` and
 * no arguments, then hydrates it from the payload.
 */
@Event()
@NewInstance()
export class UserEvent extends QueueEvent {
  public UserUUID: string;

  constructor(user?: User) {
    super();

    if (user) {
      this.UserUUID = user.Uuid;
    }
  }
}
