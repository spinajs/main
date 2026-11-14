import { RunConflict, type AbortReason } from './contract.js';

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

/** `runInline` on an `overlap: 'skip'` schedule while another run of it holds the schedule lease. */
export class ScheduleOverlap extends RunConflict {
  public static problemFields = ['runId', 'schedule'];

  constructor(public readonly schedule: string, runId: string | null) {
    super(`schedule '${schedule}' already has ${runId ? `run ${runId}` : 'a run'} in progress`, runId);
    this.name = 'ScheduleOverlap';
  }
}

/** The crash contract: an error carrying `crash: true` stands for a dead process, after which nothing is written. */
export function isCrashError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { crash?: unknown }).crash === true;
}
