import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserLoginFailed extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
