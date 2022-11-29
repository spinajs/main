import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserPasswordRestore extends QueueEvent {
  constructor(public UserUUID: string, public resetToken: string) {
    super();
  }
}
