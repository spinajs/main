import { Event, QueueEvent } from '@spinajs/queue';
import type { StructuredError } from '../contract.js';

@Event()
export class ScheduleErrorRegressed extends QueueEvent {
  public Schedule: string;
  public RunId: string;
  public Fingerprint: string;
  public Error: StructuredError;
}
