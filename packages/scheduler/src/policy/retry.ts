import type { AbortReason } from '../contract.js';
import { NonRetryableError } from '../errors.js';
import type { NormalizedRetry, ScheduleDefinition } from '../interfaces.js';

/**
 * The retry policy the scheduler applies itself. `runOn: 'all'` runs are local work: a retry would be a
 * claimable row any replica could pick up, so they get none (the next local occurrence is the retry).
 * Emit mode leaves retries to the queue, which `decideAfterFailure` handles through `emit`.
 */
export function automaticRetry(
  def: Pick<ScheduleDefinition, 'retry' | 'runOn'> | undefined,
): NormalizedRetry | undefined {
  return def?.runOn === 'all' ? undefined : def?.retry;
}

export function computeBackoff(retry: NormalizedRetry, attempt: number, random: () => number = Math.random): number {
  if (retry.backoff === 'fixed') return retry.delayMs;
  const base = Math.min(retry.delayMs * 2 ** (attempt - 1), retry.maxDelayMs);
  const jittered = base * (1 + (random() * 2 - 1) * 0.1);
  return Math.round(Math.min(jittered, retry.maxDelayMs));
}

export function isRetryable(retry: NormalizedRetry, error: unknown): boolean {
  if (error instanceof NonRetryableError) return false;
  if (!retry.retryOn) return true;
  try {
    return !!retry.retryOn(error);
  } catch {
    return false;
  }
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
 * get to turn a shutdown or an expired lease into a final status (design §6).
 */
const INFRASTRUCTURE_ABORTS: ReadonlySet<AbortReason> = new Set(['shutdown', 'lease-expired']);

export function decideAfterFailure(input: FailureInput, random?: () => number): FailureDecision {
  if (input.abortReason === 'cancelled') return { status: 'aborted', countsAsFailure: false };
  const terminal = input.abortReason ? 'aborted' : 'failed';
  // Health (design §9) counts runs that end failed or dead. Of the aborts only a timeout is the task's
  // own failure; a shutdown or a lost/expired lease says nothing about the schedule. `dead` always counts.
  const countsAsFailure = input.abortReason === undefined || input.abortReason === 'timeout';
  // emit mode: the queue owns retries
  if (!input.retry || input.emit) return { status: terminal, countsAsFailure };
  const retryable =
    input.abortReason !== undefined && INFRASTRUCTURE_ABORTS.has(input.abortReason)
      ? true
      : isRetryable(input.retry, input.error);
  if (!retryable) return { status: terminal, countsAsFailure };
  // R11: `attempts` counts the first try
  if (input.attempt < (input.maxAttempts ?? input.retry.attempts)) {
    return { status: 'retrying', delayMs: computeBackoff(input.retry, input.attempt, random), countsAsFailure: false };
  }
  return { status: 'dead', countsAsFailure: true };
}
