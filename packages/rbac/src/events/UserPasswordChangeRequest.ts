import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserPasswordChangeRequest extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
