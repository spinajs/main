import { Event, QueueEvent } from '@spinajs/queue';
import type { RunStatus, StructuredError } from '../contract.js';

/** A run that ended `failed`, `dead` or `aborted` by its timeout; other aborts are not failures. */
@Event()
export class ScheduleRunFailed extends QueueEvent {
  public Schedule: string;
  public RunId: string;
  public Attempt: number;
  public Status: RunStatus;
  public Error: StructuredError | null;
}
