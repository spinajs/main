import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserMetadataAdded extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
