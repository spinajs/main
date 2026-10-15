import { v5 as uuidv5 } from 'uuid';
import type { RunModel } from '../models/RunModel.js';

export const SCHEDULER_JOB_NAMESPACE = '5f0c5c2e-8f52-4a39-9d55-0b6f2c6f9a41';

/** Fields set on the emitted job next to `JobId`. */
export interface ScheduledJobPayload {
  SchedulerRunId: string;
  Schedule: string;
  ScheduledAt: string;
  Params: Record<string, unknown>;
}

export function emitJobKey(schedule: string, scheduledAt: number): string {
  return `${schedule}:${new Date(scheduledAt).toISOString()}`;
}

// queue_jobs.JobId is VARCHAR(36); the readable key does not fit, a name-based UUID does.
export function emitJobId(schedule: string, scheduledAt: number): string {
  return uuidv5(emitJobKey(schedule, scheduledAt), SCHEDULER_JOB_NAMESPACE);
}

/**
 * Readable job key of a run. Manual runs and retries store `ScheduledAt = now`, which several of them
 * share (all retries of one retry-failed call), and the queue skips a job id that already finished,
 * so they are keyed on the run instead of the occurrence.
 */
export function runJobKey(run: Pick<RunModel, 'Id' | 'Schedule' | 'Trigger' | 'ScheduledAt'>): string {
  if ((run.Trigger === 'schedule' || run.Trigger === 'catch-up') && run.ScheduledAt !== null) {
    return emitJobKey(run.Schedule, run.ScheduledAt);
  }
  return `${run.Schedule}:run:${run.Id}`;
}

export function runJobId(run: Pick<RunModel, 'Id' | 'Schedule' | 'Trigger' | 'ScheduledAt'>): string {
  return uuidv5(runJobKey(run), SCHEDULER_JOB_NAMESPACE);
}
