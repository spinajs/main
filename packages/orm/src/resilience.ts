/**
 * Lifecycle state of a driver's connection to its database.
 */
export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',

  /** Reachable but failing health probes, or mid-reconnect. Queries are still attempted. */
  Degraded = 'degraded',
}

export interface IConnectionResilienceOptions {
  /**
   * Milliseconds between health probes. 0 disables the periodic probe. Default 30000.
   */
  HealthCheckInterval?: number;

  /**
   * Reconnect attempts per outage before giving up. Default 5.
   */
  MaxRetries?: number;

  /**
   * First backoff delay in ms; doubles each attempt. Default 200.
   */
  RetryDelay?: number;

  /**
   * Upper bound on the backoff delay in ms. Default 5000.
   */
  MaxRetryDelay?: number;
}

/**
 * Error codes that mean the transport died rather than the statement being wrong. Retrying a
 * statement that the server rejected only multiplies the failure, so this set is deliberately
 * narrow: connection-level Node socket errors plus the mysql2 protocol codes for a lost or
 * exhausted connection.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ER_CON_COUNT_ERROR',
  'ER_LOCK_WAIT_TIMEOUT',
  'SQLITE_BUSY',
]);

/**
 * Backoff delay for attempt `n` (0-based), doubling from `base` and clamped to `max`.
 */
export function backoffDelay(attempt: number, base: number, max: number): number {
  return Math.min(base * Math.pow(2, attempt), max);
}

/**
 * Promise-returning sleep used by the retry loop.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walks an error and its `inner` / `cause` chain looking for a retryable code. Driver errors are
 * frequently wrapped ( OrmException carries the original in `inner` ), so a shallow check misses
 * exactly the cases that matter.
 */
export function isRetryableErrorCode(err: unknown): boolean {
  let current: any = err;
  let depth = 0;

  while (current && depth < 5) {
    const code = current.code ?? current.errno;
    if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }

    current = current.inner ?? current.cause;
    depth++;
  }

  return false;
}
