import type { Ceiling, PrincipalType } from '@spinajs/authz';
import type { IQueueMessage } from '@spinajs/queue';

// Mirrors the hook lane L6 adds to @spinajs/queue.
export abstract class QueueMessageHook {
  abstract beforeEmit(message: IQueueMessage): void | Promise<void>; // in QueueService.emit
  abstract aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T>; // in the consumer, around ev.execute
}

// @Job(opts?); no runAs ⇒ the handler runs as UNATTENDED (B30)
export interface JobOptions {
  runAs?: 'initiator' | 'system';
}

// stamped on message.Initiator by beforeEmit
export interface Initiator {
  readonly type: PrincipalType;
  readonly id: string;
  readonly ceiling?: Ceiling;
}
