import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserRoleRevoked extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
