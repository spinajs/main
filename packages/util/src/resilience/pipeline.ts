import { TimeSpanLike } from '../timespan.js';
import { Executor, ResilienceContext, ResilienceStrategy } from './core.js';
import { circuitBreakerStrategy, CircuitBreakerStrategyOptions } from './strategies/circuitBreaker.js';
import { concurrencyLimiterStrategy, ConcurrencyLimiterStrategyOptions } from './strategies/concurrencyLimiter.js';
import { fallbackStrategy, FallbackStrategyOptions } from './strategies/fallback.js';
import { hedgingStrategy, HedgingStrategyOptions } from './strategies/hedging.js';
import { retryStrategy, RetryStrategyOptions } from './strategies/retry.js';
import { timeoutStrategy, TimeoutStrategyOptions } from './strategies/timeout.js';

/**
 * An executable chain of resilience strategies. Reusable and thread-safe across calls
 * ( stateful strategies such as the circuit breaker share their state between executions ).
 */
export class ResiliencePipeline<T> {
  constructor(private readonly strategies: ResilienceStrategy<T>[]) {}

  /**
   * Executes the callback through the strategy chain.
   *
   * @param callback - operation to guard. Receives the {@link ResilienceContext} ( observe `Signal` for cancellation ).
   * @param context - optional partial context ( eg. an external `Signal` or `OperationKey` ).
   */
  public execute(callback: (ctx: ResilienceContext) => Promise<T>, context?: Partial<ResilienceContext>): Promise<T> {
    let exec: Executor<T> = (ctx) => callback(ctx);

    // wrap so the first-added strategy is the outermost
    for (let i = this.strategies.length - 1; i >= 0; i--) {
      exec = this.strategies[i](exec);
    }

    const controller = new AbortController();
    const ctx: ResilienceContext = {
      Signal: context?.Signal ?? controller.signal,
      OperationKey: context?.OperationKey,
      Properties: context?.Properties ?? new Map<string, unknown>(),
    };

    return exec(ctx);
  }
}

/**
 * Fluent builder composing resilience strategies into a {@link ResiliencePipeline}.
 *
 * Strategies execute in the order they are added ( first added = outermost ), mirroring Polly.
 *
 * @example
 * const pipeline = new ResiliencePipelineBuilder<Buffer>()
 *   .addTimeout(TimeSpan.fromSeconds(10))
 *   .addRetry({ MaxRetryAttempts: 3, BackoffType: 'Exponential', UseJitter: true })
 *   .build();
 * await pipeline.execute(() => downloadAsync());
 */
export class ResiliencePipelineBuilder<T = unknown> {
  private readonly strategies: ResilienceStrategy<T>[] = [];

  public addStrategy(strategy: ResilienceStrategy<T>): this {
    this.strategies.push(strategy);
    return this;
  }

  public addRetry(options?: RetryStrategyOptions<T>): this {
    return this.addStrategy(retryStrategy<T>(options));
  }

  public addTimeout(options: TimeoutStrategyOptions | TimeSpanLike): this {
    return this.addStrategy(timeoutStrategy<T>(options));
  }

  public addCircuitBreaker(options?: CircuitBreakerStrategyOptions<T>): this {
    return this.addStrategy(circuitBreakerStrategy<T>(options));
  }

  public addFallback(options: FallbackStrategyOptions<T>): this {
    return this.addStrategy(fallbackStrategy<T>(options));
  }

  public addHedging(options?: HedgingStrategyOptions<T>): this {
    return this.addStrategy(hedgingStrategy<T>(options));
  }

  public addConcurrencyLimiter(options: ConcurrencyLimiterStrategyOptions | number): this {
    const opts = typeof options === 'number' ? { PermitLimit: options } : options;
    return this.addStrategy(concurrencyLimiterStrategy<T>(opts));
  }

  public build(): ResiliencePipeline<T> {
    return new ResiliencePipeline<T>(this.strategies.slice());
  }
}
