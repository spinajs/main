import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserRoleGranted extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
