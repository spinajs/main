export interface RetryPolicyOptions {
  /** Total attempts including the first one. */
  attempts: number;
  backoff?: 'fixed' | 'exponential';
  delay?: number | string;
  maxDelay?: number | string;
  retryOn?: (err: unknown) => boolean;
}

export interface NormalizedRetry {
  attempts: number;
  backoff: 'fixed' | 'exponential';
  delayMs: number;
  maxDelayMs: number;
  retryOn?: (err: unknown) => boolean;
}

/** Fails the attempt without automatic retries, whatever `retryOn` says. */
export class NonRetryableError extends Error {
  constructor(
    message?: string,
    public readonly inner?: unknown,
  ) {
    super(message);
    this.name = 'NonRetryableError';
  }
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
