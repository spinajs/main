import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserDeleted extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
