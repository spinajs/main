import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserUnbanned extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
