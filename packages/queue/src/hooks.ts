import type { IQueueMessage } from './interfaces.js';

export abstract class QueueMessageHook {
  abstract beforeEmit(message: IQueueMessage): void | Promise<void>; // in QueueService.emit
  abstract aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T>; // in the consumer, around ev.execute
}

// @Job(opts?)
export interface JobOptions {
  runAs?: 'initiator' | 'system';
}
