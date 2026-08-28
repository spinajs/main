import { IQueueMessage, QueueEvent, QueueJob, QueueService } from './interfaces.js';
import { resolve } from '@spinajs/di';

/**
 * Emits event / job / message to queue
 */
export async function ev(event: IQueueMessage | QueueEvent | QueueJob): Promise<string | undefined> {
  const service = await resolve(QueueService);
  return service.emit(event);
}
