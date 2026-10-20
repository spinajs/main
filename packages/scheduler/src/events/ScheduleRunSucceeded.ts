import { Event, QueueEvent } from '@spinajs/queue';

@Event()
export class ScheduleRunSucceeded extends QueueEvent {
  public Schedule: string;
  public RunId: string;
  public Attempt: number;
  public DurationMs: number | null;
}
