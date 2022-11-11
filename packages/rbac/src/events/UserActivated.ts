import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserActivated extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
