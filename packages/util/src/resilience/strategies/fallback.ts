import { Outcome, ResilienceContext, ResilienceStrategy, ShouldHandle, _capture, _resolveShouldHandle, _unwrap } from '../core.js';

export interface FallbackStrategyOptions<T> {
  /**
   * What errors / results trigger the fallback. Defaults to "any exception".
   */
  ShouldHandle?: ShouldHandle<T>;

  /**
   * Produces the substitute value when the outcome is handled.
   */
  FallbackAction: (args: { Outcome: Outcome<T>; Context: ResilienceContext }) => T | Promise<T>;

  /**
   * Called when the fallback is about to be used.
   */
  OnFallback?: (args: { Outcome: Outcome<T>; Context: ResilienceContext }) => void | Promise<void>;
}

/**
 * Substitutes a fallback value when the guarded operation produces a handled outcome.
 */
export function fallbackStrategy<T>(options: FallbackStrategyOptions<T>): ResilienceStrategy<T> {
  const shouldHandle = _resolveShouldHandle(options.ShouldHandle);

  return (next) => async (ctx) => {
    const outcome = await _capture(next, ctx);

    if (await shouldHandle(outcome)) {
      if (options.OnFallback) {
        await options.OnFallback({ Outcome: outcome, Context: ctx });
      }

      return await options.FallbackAction({ Outcome: outcome, Context: ctx });
    }

    return _unwrap(outcome);
  };
}
