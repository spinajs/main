import type { AbortReason } from './contract.js';

export class RunAbortedError extends Error {
  constructor(public readonly reason: AbortReason) {
    super(`Run aborted: ${reason}`);
    this.name = 'RunAbortedError';
  }
}

export class ScheduleValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid scheduler configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ScheduleValidationError';
  }
}

export class QueueJobFailedError extends Error {
  constructor(message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'QueueJobFailedError';
  }
}
