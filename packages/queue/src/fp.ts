import { IQueueMessage, QueueEvent, QueueJob } from './interfaces.js';
import { ev } from './helpers.js';

/**
 * Emits event / job / message to queue
 *
 * Kept for compatibility - delegates to the imperative {@link ev}.
 */
export function _ev(event: IQueueMessage | QueueEvent | QueueJob): () => Promise<string | undefined> {
  return () => ev(event);
}
