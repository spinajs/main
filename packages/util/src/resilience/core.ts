import { Constructor } from '../fp.js';
import { TimeSpan, TimeSpanLike } from '../timespan.js';
import { CanceledException } from './exceptions.js';

/**
 * Result of a guarded operation - holds either a result or an error.
 * Strategies inspect the outcome to decide whether to act ( retry, fallback, open circuit, ... ).
 */
export interface Outcome<T> {
  Result?: T;
  Error?: unknown;
}

/**
 * Ambient context flowing through a resilience pipeline execution.
 */
export interface ResilienceContext {
  /**
   * Cooperative cancellation token. Aborted when an outer strategy ( eg. timeout ) gives up.
   * Long running operations should observe it and stop early.
   */
  Signal: AbortSignal;

  /**
   * Optional logical name of the operation - useful for logging / telemetry.
   */
  OperationKey?: string;

  /**
   * Arbitrary per-execution bag of properties shared between strategies and the callback.
   */
  Properties: Map<string, unknown>;
}

/**
 * Innermost executable produced by wrapping the user callback with strategies.
 */
export type Executor<T> = (ctx: ResilienceContext) => Promise<T>;

/**
 * A strategy decorates the next executor in the chain with resilience behavior.
 */
export type ResilienceStrategy<T> = (next: Executor<T>) => Executor<T>;

/**
 * Predicate deciding whether an outcome should be handled by a strategy.
 */
export type ShouldHandlePredicate<T> = (outcome: Outcome<T>) => boolean | Promise<boolean>;

/**
 * Accepted forms of the `ShouldHandle` option - either a {@link PredicateBuilder} or a raw predicate.
 */
export type ShouldHandle<T> = PredicateBuilder<T> | ShouldHandlePredicate<T>;

export type BackoffType = 'Constant' | 'Linear' | 'Exponential';

/**
 * Fluent builder describing which errors / results a strategy should react to.
 *
 * @example
 * new PredicateBuilder<number>()
 *   .handle(IOFail)
 *   .handleResult(r => r < 0)
 */
export class PredicateBuilder<T> {
  private _predicates: ShouldHandlePredicate<T>[] = [];

  /**
   * Handle errors of the given type ( optionally further filtered by predicate ).
   */
  public handle<E extends Error>(type: Constructor<E>, predicate?: (e: E) => boolean): this {
    this._predicates.push((o) => o.Error instanceof type && (predicate ? predicate(o.Error) : true));
    return this;
  }

  /**
   * Handle any error matching the predicate.
   */
  public handleError(predicate: (e: unknown) => boolean): this {
    this._predicates.push((o) => o.Error !== undefined && predicate(o.Error));
    return this;
  }

  /**
   * Handle a successful result matching the predicate ( eg. a falsy / error-like value ).
   */
  public handleResult(predicate: (r: T) => boolean): this {
    this._predicates.push((o) => o.Error === undefined && predicate(o.Result as T));
    return this;
  }

  /**
   * Handle a specific successful result value.
   */
  public handleResultValue(value: T): this {
    return this.handleResult((r) => r === value);
  }

  public build(): ShouldHandlePredicate<T> {
    const predicates = this._predicates.slice();

    // when nothing was configured, handle every exception ( default Polly behavior )
    if (predicates.length === 0) {
      return (o) => o.Error !== undefined;
    }

    return async (o) => {
      for (const p of predicates) {
        if (await p(o)) {
          return true;
        }
      }
      return false;
    };
  }
}

/**
 * Normalizes a `ShouldHandle` option into a predicate. Defaults to "handle any exception".
 */
export function _resolveShouldHandle<T>(shouldHandle?: ShouldHandle<T>): ShouldHandlePredicate<T> {
  if (!shouldHandle) {
    return (o) => o.Error !== undefined;
  }

  if (shouldHandle instanceof PredicateBuilder) {
    return shouldHandle.build();
  }

  return shouldHandle;
}

/**
 * Runs an executor capturing its result or error into an {@link Outcome}.
 */
export async function _capture<T>(exec: Executor<T>, ctx: ResilienceContext): Promise<Outcome<T>> {
  try {
    return { Result: await exec(ctx) };
  } catch (error) {
    return { Error: error };
  }
}

/**
 * Returns the result of an outcome or rethrows its error.
 */
export function _unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.Error !== undefined) {
    throw outcome.Error;
  }

  return outcome.Result as T;
}

/**
 * Coerces a {@link TimeSpanLike} value into a {@link TimeSpan}, falling back when nil.
 */
export function _toTimeSpan(value: TimeSpanLike | undefined, fallback: TimeSpan): TimeSpan {
  if (value === undefined || value === null) {
    return fallback;
  }

  return TimeSpan.parse(value) ?? fallback;
}

/**
 * Abortable delay. Rejects with {@link CanceledException} if the signal aborts while waiting.
 */
export function _delay(ts: TimeSpan, signal?: AbortSignal): Promise<void> {
  const ms = Math.max(0, ts.totalMilliseconds);

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(_abortReason(signal));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(_abortReason(signal));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Extracts a meaningful error from an aborted signal, defaulting to {@link CanceledException}.
 */
export function _abortReason(signal?: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  return reason instanceof Error ? reason : new CanceledException('Operation was canceled');
}

/**
 * Creates a child abort controller that also aborts when the parent signal aborts.
 * Returns a disposer that detaches the parent listener.
 */
export function _linkSignal(parent: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();

  if (parent.aborted) {
    controller.abort(_abortReason(parent));
    return { controller, dispose: () => undefined };
  }

  const onAbort = () => controller.abort(_abortReason(parent));
  parent.addEventListener('abort', onAbort);

  return {
    controller,
    dispose: () => parent.removeEventListener('abort', onAbort),
  };
}

/**
 * Computes the delay before the given retry attempt ( attempt is 1-based ).
 */
export function _backoff(opts: { attempt: number; baseDelay: TimeSpan; type: BackoffType; jitter: boolean; maxDelay?: TimeSpan }): TimeSpan {
  const base = opts.baseDelay.totalMilliseconds;
  let ms: number;

  switch (opts.type) {
    case 'Linear':
      ms = base * opts.attempt;
      break;
    case 'Exponential':
      ms = base * Math.pow(2, opts.attempt - 1);
      break;
    case 'Constant':
    default:
      ms = base;
      break;
  }

  if (opts.jitter) {
    // full jitter in the [0.5x, 1.5x) band around the computed delay
    ms = ms / 2 + Math.random() * ms;
  }

  if (opts.maxDelay) {
    ms = Math.min(ms, opts.maxDelay.totalMilliseconds);
  }

  return TimeSpan.fromMilliseconds(Math.round(ms));
}
