import { TimeSpan, TimeSpanLike } from '../../timespan.js';
import { ResilienceContext, ResilienceStrategy, _linkSignal, _toTimeSpan } from '../core.js';
import { TimeoutRejectedException } from '../exceptions.js';

export interface TimeoutStrategyOptions {
  /**
   * Time after which the operation is abandoned.
   */
  Timeout: TimeSpanLike;

  /**
   * Called when the timeout fires.
   */
  OnTimeout?: (args: { Timeout: TimeSpan; Context: ResilienceContext }) => void | Promise<void>;
}

/**
 * Aborts the operation when it does not complete within the configured timeout.
 *
 * Works both ways:
 *  - pessimistic: rejects the awaiter with {@link TimeoutRejectedException} when time elapses,
 *  - optimistic: aborts the {@link ResilienceContext.Signal} so cooperative callbacks can stop early.
 */
export function timeoutStrategy<T>(options: TimeoutStrategyOptions | TimeSpanLike): ResilienceStrategy<T> {
  const opts: TimeoutStrategyOptions = isTimeoutOptions(options) ? options : { Timeout: options };
  const timeout = _toTimeSpan(opts.Timeout, TimeSpan.ZERO);

  return (next) => (ctx) => {
    const { controller, dispose } = _linkSignal(ctx.Signal);
    const childCtx: ResilienceContext = { ...ctx, Signal: controller.signal };

    let timer: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutRejectedException(`Operation timed out after ${timeout.toString()}`);
        controller.abort(error);

        Promise.resolve(opts.OnTimeout?.({ Timeout: timeout, Context: ctx })).finally(() => reject(error));
      }, timeout.totalMilliseconds);
    });

    return Promise.race([next(childCtx), timeoutPromise]).finally(() => {
      clearTimeout(timer);
      dispose();
    });
  };
}

function isTimeoutOptions(value: TimeoutStrategyOptions | TimeSpanLike): value is TimeoutStrategyOptions {
  return typeof value === 'object' && value !== null && 'Timeout' in value;
}
