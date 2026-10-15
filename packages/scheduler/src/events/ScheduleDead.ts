import { Event, QueueEvent } from '@spinajs/queue';
import type { StructuredError } from '../contract.js';

@Event()
export class ScheduleDead extends QueueEvent {
  public Schedule: string;
  public RunId: string;
  public Attempts: number;
  public Error: StructuredError | null;
}
