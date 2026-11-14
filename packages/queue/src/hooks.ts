import type { IQueueMessage } from './interfaces.js';

export abstract class QueueMessageHook {
  abstract beforeEmit(message: IQueueMessage): void | Promise<void>; // in QueueService.emit
  abstract aroundHandle<T>(message: IQueueMessage, next: () => Promise<T>): Promise<T>; // in the consumer, around ev.execute
}

// @Job(opts?)
export interface JobOptions {
  runAs?: 'initiator' | 'system';
  /** Permissions the principal the job runs as must hold, any one of them, before `execute`; a `QueueMessageHook` ( authz-queue ) checks them. */
  access?: string | readonly string[];
  /** The resource `access` is checked on; default: the type-level resource of each permission ( `invoice:send` checks `{ type: 'invoice' }` ). */
  resource?: (message: any) => { type: string; id?: string };
}

// Symbol.for: transports may load another copy of @spinajs/queue, whose class `instanceof` would not match.
const PERMANENT = Symbol.for('spinajs:queue:permanent-failure');

/**
 * A failure a retry cannot fix, such as a denied `@Job({ access })`: the consumer marks the job dead on its first failure
 * and a transport dead-letters it without a retry. `reason` leads the error message and so the dead letter's reason.
 */
export class PermanentJobFailure extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = new.target.name;
    Object.defineProperty(this, PERMANENT, { value: true });
  }
}

export const isPermanentJobFailure = (err: unknown): err is PermanentJobFailure => typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[PERMANENT] === true;
