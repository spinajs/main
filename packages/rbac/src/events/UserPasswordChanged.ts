import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserPasswordChanged extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
