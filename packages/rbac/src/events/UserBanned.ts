import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserBanned extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
