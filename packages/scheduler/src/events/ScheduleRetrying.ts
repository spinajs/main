import { Event, QueueEvent } from '@spinajs/queue';
import type { StructuredError } from '../contract.js';

@Event()
export class ScheduleRetrying extends QueueEvent {
  public Schedule: string;
  public RunId: string;
  /** The attempt that failed. */
  public Attempt: number;
  public NextAttemptAt: string;
  public Error: StructuredError | null;
}
