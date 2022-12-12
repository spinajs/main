import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserLoginSuccess extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
