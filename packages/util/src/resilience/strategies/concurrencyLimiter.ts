import { ResilienceStrategy, _abortReason } from '../core.js';
import { RateLimiterRejectedException } from '../exceptions.js';

export interface ConcurrencyLimiterStrategyOptions {
  /**
   * Maximum number of concurrent executions allowed.
   */
  PermitLimit: number;

  /**
   * Maximum number of executions allowed to wait for a permit. Default 0 ( reject immediately ).
   */
  QueueLimit?: number;
}

/** Live counters of one {@link concurrencyLimiterStrategy}. */
export interface ConcurrencyLimiterStats {
  /** Executions holding a permit. */
  readonly active: number;
  /** Executions waiting for a permit. */
  readonly queued: number;
  /** The highest `active` seen. */
  readonly peak: number;
  /** Executions started so far. */
  readonly runs: number;
}

export type ConcurrencyLimiterStrategy<T> = ResilienceStrategy<T> & { readonly stats: ConcurrencyLimiterStats };

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * Bounds the number of concurrent executions ( bulkhead isolation ). Extra calls either queue
 * ( up to `QueueLimit` ) or are rejected with {@link RateLimiterRejectedException}. The returned strategy's
 * `stats` reads its live counters.
 */
export function concurrencyLimiterStrategy<T>(options: ConcurrencyLimiterStrategyOptions): ConcurrencyLimiterStrategy<T> {
  const permitLimit = options.PermitLimit;
  const queueLimit = options.QueueLimit ?? 0;

  let active = 0;
  let peak = 0;
  let runs = 0;
  const queue: Waiter[] = [];

  const acquire = (signal: AbortSignal): Promise<void> => {
    if (active < permitLimit) {
      active++;
      return Promise.resolve();
    }

    if (queue.length >= queueLimit) {
      return Promise.reject(new RateLimiterRejectedException('Concurrency limit reached and queue is full'));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };

      waiter.onAbort = () => {
        const idx = queue.indexOf(waiter);
        if (idx >= 0) {
          queue.splice(idx, 1);
        }
        reject(_abortReason(signal));
      };

      if (signal.aborted) {
        reject(_abortReason(signal));
        return;
      }

      signal.addEventListener('abort', waiter.onAbort);
      queue.push(waiter);
    });
  };

  const release = () => {
    const waiter = queue.shift();
    if (waiter) {
      // hand the permit directly to the next waiter ( active stays the same )
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve();
    } else {
      active--;
    }
  };

  const strategy: ResilienceStrategy<T> = (next) => async (ctx) => {
    await acquire(ctx.Signal);
    peak = Math.max(peak, active);
    runs++;
    try {
      return await next(ctx);
    } finally {
      release();
    }
  };

  const stats: ConcurrencyLimiterStats = {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    get peak() {
      return peak;
    },
    get runs() {
      return runs;
    },
  };
  return Object.assign(strategy, { stats });
}
