import { QueueEvent, Event } from '@spinajs/queue';

@Event()
export class UserChanged extends QueueEvent {
  public Uuid: string;
}
