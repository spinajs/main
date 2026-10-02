export interface ReconnectOptions {
  minMs: number;
  maxMs: number;
  /** Fraction in [0, 1] by which a delay is randomly varied. */
  jitter: number;
}

export const DEFAULT_RECONNECT: Readonly<ReconnectOptions> = Object.freeze({ minMs: 500, maxMs: 30_000, jitter: 0.3 });

export class ReconnectPolicy {
  public readonly options: Readonly<ReconnectOptions>;

  constructor(options: Partial<ReconnectOptions> = {}, private readonly random: () => number = Math.random) {
    const merged = { ...DEFAULT_RECONNECT, ...options };
    if (!(merged.minMs >= 0)) throw new RangeError(`reconnect.minMs must be >= 0, got ${merged.minMs}`);
    if (!(merged.maxMs >= merged.minMs)) throw new RangeError(`reconnect.maxMs must be >= minMs, got ${merged.maxMs}`);
    if (!(merged.jitter >= 0 && merged.jitter <= 1)) throw new RangeError(`reconnect.jitter must be within [0, 1], got ${merged.jitter}`);
    this.options = Object.freeze(merged);
  }

  /**
   * Delay before retry `attempt` (0 = the first retry after a failure). Jitter only shortens the
   * exponential delay, so maxMs is a hard ceiling. A server hint is a floor, spread upwards so that
   * clients told the same retryAfterMs do not all come back at once.
   */
  public delay(attempt: number, retryAfterMs?: number): number {
    const { minMs, maxMs, jitter } = this.options;
    // clamped: 2 ** 1024 is Infinity, and 0 * Infinity is NaN
    const exponential = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 64));
    const backoff = Math.round(exponential * (1 - jitter * this.random()));
    if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return backoff;
    // a hostile or buggy server must not park the client for days
    const hinted = Math.min(Math.round(retryAfterMs * (1 + jitter * this.random())), maxMs * 10);
    return Math.max(backoff, hinted);
  }
}
