import { TimeSpan, TimeSpanLike } from '../../timespan.js';
import { Outcome, ResilienceContext, ResilienceStrategy, ShouldHandle, _linkSignal, _resolveShouldHandle, _toTimeSpan } from '../core.js';
import { HedgingException } from '../exceptions.js';

export interface HedgingStrategyOptions<T> {
  /**
   * What errors / results trigger an immediate extra attempt. Defaults to "any exception".
   */
  ShouldHandle?: ShouldHandle<T>;

  /**
   * Number of extra ( hedged ) attempts beyond the original. Default 1.
   */
  MaxHedgedAttempts?: number;

  /**
   * How long to wait for the previous attempt before starting the next hedge. Default 2 seconds.
   * A handled failure starts the next hedge immediately regardless of this delay.
   */
  Delay?: TimeSpanLike;

  /**
   * Produces the action for a given attempt. Defaults to re-running the inner pipeline.
   */
  ActionGenerator?: (args: { AttemptNumber: number; Context: ResilienceContext }) => () => Promise<T>;
}

type AttemptResult<T> = { index: number; outcome: Outcome<T> };

/**
 * Runs several attempts of the operation in parallel ( staggered by `Delay` ), returning the
 * first non-handled outcome and canceling the losers. Useful to cut tail latency.
 */
export function hedgingStrategy<T>(options: HedgingStrategyOptions<T> = {}): ResilienceStrategy<T> {
  const maxHedged = options.MaxHedgedAttempts ?? 1;
  const delay = _toTimeSpan(options.Delay, TimeSpan.fromSeconds(2));
  const shouldHandle = _resolveShouldHandle(options.ShouldHandle);
  const total = maxHedged + 1;

  return (next) => async (ctx) => {
    const controllers: AbortController[] = [];
    const pending = new Map<number, Promise<AttemptResult<T>>>();
    let launched = 0;
    let lastOutcome: Outcome<T> | undefined;

    const launch = () => {
      const index = launched++;
      const { controller, dispose } = _linkSignal(ctx.Signal);
      controllers.push(controller);
      const childCtx: ResilienceContext = { ...ctx, Signal: controller.signal };
      const generated = options.ActionGenerator?.({ AttemptNumber: index, Context: childCtx });
      const exec = generated ?? (() => next(childCtx));

      const p = (async (): Promise<AttemptResult<T>> => {
        try {
          return { index, outcome: { Result: await exec() } };
        } catch (error) {
          return { index, outcome: { Error: error } };
        } finally {
          dispose();
        }
      })();

      pending.set(index, p);
    };

    const abortOthers = (keep: number) => {
      controllers.forEach((c, i) => {
        if (i !== keep) {
          c.abort();
        }
      });
    };

    launch();

    for (;;) {
      const racers: Promise<AttemptResult<T> | 'delay'>[] = [...pending.values()];

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (launched < total) {
        racers.push(new Promise<'delay'>((resolve) => (timer = setTimeout(() => resolve('delay'), delay.totalMilliseconds))));
      }

      const result = await Promise.race(racers);
      if (timer) {
        clearTimeout(timer);
      }

      if (result === 'delay') {
        launch();
        continue;
      }

      pending.delete(result.index);
      const handled = await shouldHandle(result.outcome);

      if (!handled) {
        abortOthers(result.index);
        return result.outcome.Result as T;
      }

      lastOutcome = result.outcome;

      if (launched < total) {
        launch();
      } else if (pending.size === 0) {
        break;
      }
    }

    if (lastOutcome?.Error !== undefined) {
      throw lastOutcome.Error;
    }
    if (lastOutcome) {
      return lastOutcome.Result as T;
    }
    throw new HedgingException('All hedged attempts failed');
  };
}
