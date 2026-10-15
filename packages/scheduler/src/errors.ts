import type { AbortReason } from './contract.js';

/** Throw from task code to fail the run without automatic retries. */
export class NonRetryableError extends Error {
  constructor(message?: string, public readonly inner?: unknown) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

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
  constructor(message: string) {
    super(message);
    this.name = 'QueueJobFailedError';
  }
}
