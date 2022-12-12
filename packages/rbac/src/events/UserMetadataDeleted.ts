import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserMetadataDeleted extends QueueEvent {
  constructor(public UserUUID: string) {
    super();
  }
}
