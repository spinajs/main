import { computeBackoff, isRetryable, type NormalizedRetry } from '@spinajs/durable';
import type { AbortReason } from '../contract.js';
import type { ScheduleDefinition } from '../interfaces.js';

/**
 * The retry policy the scheduler applies itself. `runOn: 'all'` runs are local work: a retry would be a
 * claimable row any replica could pick up, so they get none (the next local occurrence is the retry).
 * Emit mode leaves retries to the queue.
 */
export function automaticRetry(
  def: Pick<ScheduleDefinition, 'retry' | 'runOn' | 'emit'> | undefined,
): NormalizedRetry | undefined {
  return def?.runOn === 'all' || def?.emit ? undefined : def?.retry;
}

export interface FailureInput {
  retry?: NormalizedRetry;
  emit: boolean;
  /** The attempt that just ended. */
  attempt: number;
  /** Total attempts of this run (the run row's `MaxAttempts`); defaults to `retry.attempts`. */
  maxAttempts?: number;
  error: unknown;
  abortReason?: AbortReason;
}

export type FailureDecision =
  | { status: 'retrying'; delayMs: number; countsAsFailure: false }
  | { status: 'failed' | 'dead' | 'aborted'; countsAsFailure: boolean };

/**
 * A replica going away is not the task's failure, so `retryOn` (written against task errors) does not
 * get to turn a shutdown or an expired lease into a final status.
 */
const INFRASTRUCTURE_ABORTS: ReadonlySet<AbortReason> = new Set(['shutdown', 'lease-expired']);

export function decideAfterFailure(input: FailureInput, random?: () => number): FailureDecision {
  if (input.abortReason === 'cancelled') return { status: 'aborted', countsAsFailure: false };
  const terminal = input.abortReason ? 'aborted' : 'failed';
  // Health counts runs that end failed or dead. Of the aborts only a timeout is the task's
  // own failure; a shutdown or a lost/expired lease says nothing about the schedule. `dead` always counts.
  const countsAsFailure = input.abortReason === undefined || input.abortReason === 'timeout';
  // emit mode: the queue owns retries
  if (!input.retry || input.emit) return { status: terminal, countsAsFailure };
  const retryable =
    input.abortReason !== undefined && INFRASTRUCTURE_ABORTS.has(input.abortReason)
      ? true
      : isRetryable(input.retry, input.error);
  if (!retryable) return { status: terminal, countsAsFailure };
  // `attempts` counts the first try, like the queue's MaxAttempts
  if (input.attempt < (input.maxAttempts ?? input.retry.attempts)) {
    return { status: 'retrying', delayMs: computeBackoff(input.retry, input.attempt, random), countsAsFailure: false };
  }
  return { status: 'dead', countsAsFailure: true };
}
