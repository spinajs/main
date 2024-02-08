import { QueueEvent, Event } from '@spinajs/queue';
import { DateTime } from 'luxon';

@Event()
export class UserLogged extends QueueEvent {
  constructor(public UserUUID: string, public datetime: DateTime) {
    super();
  }
}
