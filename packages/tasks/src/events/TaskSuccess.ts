import { Event, QueueEvent } from '@spinajs/queue';

@Event()
export class TaskSuccess extends QueueEvent {
  public TaskName: string;
}
