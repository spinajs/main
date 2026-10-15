import { Event, QueueEvent } from '@spinajs/queue';

@Event()
export class SchedulePausedByFailures extends QueueEvent {
  public Schedule: string;
  public ConsecutiveFailures: number;
}
