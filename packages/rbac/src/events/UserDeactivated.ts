import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserDeactivated extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
