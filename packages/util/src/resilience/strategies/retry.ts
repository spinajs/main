import { TimeSpan, TimeSpanLike } from '../../timespan.js';
import { BackoffType, Outcome, ResilienceStrategy, ShouldHandle, _backoff, _capture, _delay, _resolveShouldHandle, _toTimeSpan, _unwrap } from '../core.js';

export interface OnRetryArguments<T> {
  /**
   * 1-based number of the retry about to happen.
   */
  AttemptNumber: number;
  /**
   * Outcome that triggered the retry.
   */
  Outcome: Outcome<T>;
  /**
   * Delay that will be awaited before the retry.
   */
  RetryDelay: TimeSpan;
}

export interface RetryStrategyOptions<T> {
  /**
   * What errors / results should be retried. Defaults to "any exception".
   */
  ShouldHandle?: ShouldHandle<T>;

  /**
   * Maximum number of retries ( total executions = MaxRetryAttempts + 1 ). Default 3.
   */
  MaxRetryAttempts?: number;

  /**
   * Base delay between retries. Default 2 seconds.
   */
  Delay?: TimeSpanLike;

  /**
   * How the delay grows across attempts. Default 'Constant'.
   */
  BackoffType?: BackoffType;

  /**
   * Adds randomness to the delay to avoid retry storms. Default false.
   */
  UseJitter?: boolean;

  /**
   * Upper bound for the computed delay.
   */
  MaxDelay?: TimeSpanLike;

  /**
   * Custom delay generator. When it returns a value it overrides the backoff calculation.
   */
  DelayGenerator?: (args: { AttemptNumber: number; Outcome: Outcome<T> }) => TimeSpanLike | undefined | Promise<TimeSpanLike | undefined>;

  /**
   * Called right before each retry delay.
   */
  OnRetry?: (args: OnRetryArguments<T>) => void | Promise<void>;
}

/**
 * Retries the operation while the outcome is handled, up to `MaxRetryAttempts` times,
 * waiting between attempts according to the configured backoff.
 */
export function retryStrategy<T>(options: RetryStrategyOptions<T> = {}): ResilienceStrategy<T> {
  const maxAttempts = options.MaxRetryAttempts ?? 3;
  const baseDelay = _toTimeSpan(options.Delay, TimeSpan.fromSeconds(2));
  const backoffType = options.BackoffType ?? 'Constant';
  const useJitter = options.UseJitter ?? false;
  const maxDelay = options.MaxDelay ? _toTimeSpan(options.MaxDelay, TimeSpan.MAX_VALUE) : undefined;
  const shouldHandle = _resolveShouldHandle(options.ShouldHandle);

  return (next) => async (ctx) => {
    let attempt = 0;

    for (;;) {
      const outcome = await _capture(next, ctx);
      const handled = await shouldHandle(outcome);

      if (!handled || attempt >= maxAttempts) {
        return _unwrap(outcome);
      }

      attempt++;

      let delay: TimeSpan | undefined;
      if (options.DelayGenerator) {
        const custom = await options.DelayGenerator({ AttemptNumber: attempt, Outcome: outcome });
        delay = custom !== undefined && custom !== null ? _toTimeSpan(custom, TimeSpan.ZERO) : undefined;
      }

      if (!delay) {
        delay = _backoff({ attempt, baseDelay, type: backoffType, jitter: useJitter, maxDelay });
      }

      if (options.OnRetry) {
        await options.OnRetry({ AttemptNumber: attempt, Outcome: outcome, RetryDelay: delay });
      }

      if (delay.totalMilliseconds > 0) {
        await _delay(delay, ctx.Signal);
      }
    }
  };
}
