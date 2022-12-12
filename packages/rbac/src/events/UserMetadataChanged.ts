import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserMetadataChanged extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
