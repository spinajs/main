import { Event, QueueEvent } from '@spinajs/queue';
import type { RunTrigger } from '../contract.js';

@Event()
export class ScheduleRunStarted extends QueueEvent {
  public Schedule: string;
  public RunId: string;
  public Trigger: RunTrigger;
  public Attempt: number;
  public ScheduledAt: string | null;
}
