import { Constructor, isPromise } from './types.js';
import { TimeSpan } from './timespan.js';
import { sleep } from './process.js';
import { BackoffType, Outcome, _abortReason } from './resilience/core.js';
import { retryStrategy } from './resilience/strategies/retry.js';
import { timeoutStrategy } from './resilience/strategies/timeout.js';

/**
 * Value that may be wrapped in a promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A single typed step of `_chain` / `_pipe` - receives the previous result.
 */
export type ChainFn<A, B> = (arg: A) => MaybePromise<B>;

/**
 * Merged accumulator shape used by context-building steps (`_use`, `_struct`).
 * Non-object inputs (undefined start of a chain) begin a fresh context.
 */
type Ctx<A> = A extends object ? A : object;

const RESCUE_HANDLER = Symbol('fp rescue handler');

/**
 * Invokes `fn` converting synchronous throws into rejections,
 * so error handlers are always called, regardless of how the error was raised.
 */
function _invoke<Args extends unknown[], R>(fn: (...args: Args) => MaybePromise<R>, args: Args): Promise<R> {
  try {
    return Promise.resolve(fn(...args));
  } catch (err) {
    return Promise.reject(err);
  }
}

function _reduceSteps(initial: Promise<unknown>, fns: Array<(arg?: unknown) => unknown>): Promise<unknown> {
  for (const fn of fns) {
    if (typeof fn !== 'function') {
      throw new Error(`chain steps must be functions, got ${typeof fn} - wrap plain values in a thunk: () => value`);
    }
  }

  return fns.reduce<Promise<unknown>>((prev, curr) => {
    const rescue = (curr as { [RESCUE_HANDLER]?: (err: unknown) => unknown })[RESCUE_HANDLER];
    if (rescue) {
      return prev.then(
        (res) => res,
        (err) => rescue(err),
      );
    }

    return prev.then((res) => curr(res));
  }, initial);
}

/**
 * Chains a list of functions together, passing the result of each function to the next.
 * Executes eagerly - for a reusable, lazy pipeline see `_pipe`.
 *
 * Steps are functions (sync or async); the first step receives no argument.
 * Types flow through the chain - step parameters and the final result are inferred.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => Promise.resolve(1),
 *   (v) => v + 1,
 *   (v) => Promise.resolve(v * 2),
 * ); // 4, typed number
 * ```
 */
export function _chain(): Promise<null>;
export function _chain<A>(a: () => MaybePromise<A>): Promise<A>;
export function _chain<A, B>(a: () => MaybePromise<A>, ab: ChainFn<A, B>): Promise<B>;
export function _chain<A, B, C>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>): Promise<C>;
export function _chain<A, B, C, D>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>): Promise<D>;
export function _chain<A, B, C, D, E>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>): Promise<E>;
export function _chain<A, B, C, D, E, F>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>): Promise<F>;
export function _chain<A, B, C, D, E, F, G>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>): Promise<G>;
export function _chain<A, B, C, D, E, F, G, H>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>): Promise<H>;
export function _chain<A, B, C, D, E, F, G, H, I>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>): Promise<I>;
export function _chain<A, B, C, D, E, F, G, H, I, J>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>, ij: ChainFn<I, J>): Promise<J>;
export function _chain<A, B, C, D, E, F, G, H, I, J, K>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>, ij: ChainFn<I, J>, jk: ChainFn<J, K>): Promise<K>;
export function _chain<A, B, C, D, E, F, G, H, I, J, K, L>(a: () => MaybePromise<A>, ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>, ij: ChainFn<I, J>, jk: ChainFn<J, K>, kl: ChainFn<K, L>): Promise<L>;
export function _chain(...fns: Array<(arg?: unknown) => unknown>): Promise<unknown>;
export function _chain(...fns: Array<(arg?: unknown) => unknown>): Promise<unknown> {
  return _reduceSteps(Promise.resolve(null), fns);
}

/**
 * Lazy variant of `_chain` - composes steps into a reusable function.
 * The argument passed to the composed function is fed into the first step.
 *
 * @example
 * ```ts
 * const pipeline = _pipe((v: number) => v + 1, (v) => v * 2);
 * await pipeline(2); // 6
 * await pipeline(5); // 12
 * ```
 */
export function _pipe<A, B>(ab: ChainFn<A, B>): (arg: A) => Promise<B>;
export function _pipe<A, B, C>(ab: ChainFn<A, B>, bc: ChainFn<B, C>): (arg: A) => Promise<C>;
export function _pipe<A, B, C, D>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>): (arg: A) => Promise<D>;
export function _pipe<A, B, C, D, E>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>): (arg: A) => Promise<E>;
export function _pipe<A, B, C, D, E, F>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>): (arg: A) => Promise<F>;
export function _pipe<A, B, C, D, E, F, G>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>): (arg: A) => Promise<G>;
export function _pipe<A, B, C, D, E, F, G, H>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>): (arg: A) => Promise<H>;
export function _pipe<A, B, C, D, E, F, G, H, I>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>): (arg: A) => Promise<I>;
export function _pipe<A, B, C, D, E, F, G, H, I, J>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>, ij: ChainFn<I, J>): (arg: A) => Promise<J>;
export function _pipe<A, B, C, D, E, F, G, H, I, J, K>(ab: ChainFn<A, B>, bc: ChainFn<B, C>, cd: ChainFn<C, D>, de: ChainFn<D, E>, ef: ChainFn<E, F>, fg: ChainFn<F, G>, gh: ChainFn<G, H>, hi: ChainFn<H, I>, ij: ChainFn<I, J>, jk: ChainFn<J, K>): (arg: A) => Promise<K>;
export function _pipe(...fns: Array<(arg?: unknown) => unknown>): (arg?: unknown) => Promise<unknown>;
export function _pipe(...fns: Array<(arg?: unknown) => unknown>): (arg?: unknown) => Promise<unknown> {
  return (arg?: unknown) => _reduceSteps(Promise.resolve(arg), fns);
}

/**
 * Step-shaped error boundary for `_chain` / `_pipe`. On upstream failure the handler
 * is called and its result becomes the recovery value the chain continues with.
 * On success the value passes through untouched and the handler is not called.
 * Errors thrown by steps AFTER the rescue are not caught by it.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => loadFromCache(),
 *   _rescue(() => loadFromDb()),
 *   (v) => v.id,
 * );
 * ```
 */
export function _rescue<R>(handler: (err: unknown) => MaybePromise<R>): <T>(arg: T) => Promise<T | R> {
  const step = <T>(arg: T): Promise<T | R> => Promise.resolve(arg);
  (step as { [RESCUE_HANDLER]?: unknown })[RESCUE_HANDLER] = handler;
  return step;
}

/**
 * Runs all functions with the same input value, resolves with an array of results.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => 2,
 *   _fanout(
 *     async (v: number) => v + 1,
 *     async (v: number) => v * 10,
 *   ),
 * ); // [3, 20]
 * ```
 */
export function _fanout<T = any, F extends ((arg: T) => unknown)[] = ((arg: T) => unknown)[]>(...fns: F) {
  return (val?: T): Promise<{ [K in keyof F]: Awaited<ReturnType<F[K]>> }> => Promise.all(fns.map((fn) => _invoke(fn, [val as T]))) as Promise<{ [K in keyof F]: Awaited<ReturnType<F[K]>> }>;
}

/**
 * Maps every element of the input array with the callback, resolving all results (parallel).
 * For serial, one-at-a-time mapping see `_sequence`.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => [1, 2, 3],
 *   _map(async (v: number) => v * v),
 * ); // [1, 4, 9]
 * ```
 */
export function _map<T, R>(callback: (val: T) => MaybePromise<R>) {
  return (val: T[]): Promise<R[]> => {
    if (!Array.isArray(val)) {
      throw new Error(`_map expects an array, got ${typeof val}`);
    }

    return Promise.all(val.map((v) => callback(v)));
  };
}

/**
 * Filters elements of the input array with an (possibly async) predicate.
 * Order of elements is preserved.
 *
 * @example
 * ```ts
 * const res = await _filter(async (v: number) => v % 2 === 0)([1, 2, 3, 4]); // [2, 4]
 * ```
 */
export function _filter<T>(predicate: (val: T) => MaybePromise<boolean>) {
  return (val: T[]): Promise<T[]> => {
    if (!Array.isArray(val)) {
      throw new Error(`_filter expects an array, got ${typeof val}`);
    }

    return Promise.all(val.map((v) => predicate(v))).then((keep) => val.filter((_, i) => keep[i]));
  };
}

/**
 * Reduces the input array with an (possibly async) reducer, starting from `initial`.
 * Elements are processed serially, in order.
 *
 * @example
 * ```ts
 * const sum = await _reduce(async (acc: number, v: number) => acc + v, 10)([1, 2, 3]); // 16
 * ```
 */
export function _reduce<T, R>(reducer: (acc: R, val: T) => MaybePromise<R>, initial: R) {
  return (val: T[]): Promise<R> => {
    if (!Array.isArray(val)) {
      throw new Error(`_reduce expects an array, got ${typeof val}`);
    }

    return val.reduce((acc: Promise<R>, v) => acc.then((a) => reducer(a, v)), Promise.resolve(initial));
  };
}

/**
 * Maps every element of the input array serially - next element is processed
 * only after the previous one resolved. Parallel variant is `_map`.
 *
 * @example
 * ```ts
 * // requests fire one at a time, never concurrently
 * const res = await _sequence(async (id: number) => fetchUser(id))([1, 2, 3]);
 * ```
 */
export function _sequence<T, R>(callback: (val: T) => MaybePromise<R>) {
  return (val: T[]): Promise<R[]> => {
    if (!Array.isArray(val)) {
      throw new Error(`_sequence expects an array, got ${typeof val}`);
    }

    const run = async () => {
      const result: R[] = [];
      for (const v of val) {
        result.push(await callback(v));
      }
      return result;
    };

    return run();
  };
}

/**
 * Options for `_concurrent`.
 */
export interface ConcurrentOptions {
  /**
   * Cooperative cancellation - when the signal aborts, no new items are claimed
   * and the mapping rejects with the abort reason. In-flight callbacks are not interrupted.
   */
  signal?: AbortSignal;

  /**
   * When true, a failed item stops the remaining workers from claiming new items.
   * Default false - remaining items keep processing even though the mapping already rejected.
   */
  failFast?: boolean;
}

/**
 * Maps every element of the input array with at most `concurrency` callbacks
 * running at the same time - middle ground between `_sequence` (one at a time)
 * and `_map` (all at once). Order of results is preserved regardless of
 * completion order.
 *
 * @example
 * ```ts
 * // at most 2 requests in flight at any moment
 * const res = await _concurrent(async (id: number) => fetchUser(id), 2)([1, 2, 3, 4, 5]);
 * ```
 */
export function _concurrent<T, R>(callback: (val: T) => MaybePromise<R>, concurrency: number, options?: ConcurrentOptions) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`_concurrent concurrency must be a positive integer, got ${concurrency}`);
  }

  return (val: T[]): Promise<R[]> => {
    if (!Array.isArray(val)) {
      throw new Error(`_concurrent expects an array, got ${typeof val}`);
    }

    if (options?.signal?.aborted) {
      return Promise.reject(_abortReason(options.signal));
    }

    const result: R[] = new Array<R>(val.length);
    let next = 0;
    let failed = false;

    const worker = async () => {
      while (next < val.length) {
        if (options?.signal?.aborted) {
          throw _abortReason(options.signal);
        }

        if (failed && options?.failFast) {
          return;
        }

        const i = next++;
        try {
          result[i] = await callback(val[i]);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, val.length) }, () => worker());
    return Promise.all(workers).then(() => result);
  };
}

/**
 * Splits the input array into batches of at most `size` elements.
 * Pure chunking - compose with `_sequence` / `_map` / `_concurrent` for batched processing.
 *
 * @example
 * ```ts
 * _batch(3)([1, 2, 3, 4, 5, 6, 7]); // [[1, 2, 3], [4, 5, 6], [7]]
 * ```
 */
export function _batch<T>(size: number) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`_batch size must be a positive integer, got ${size}`);
  }

  return (val: T[]): T[][] => {
    if (!Array.isArray(val)) {
      throw new Error(`_batch expects an array, got ${typeof val}`);
    }

    const batches: T[][] = [];
    for (let i = 0; i < val.length; i += size) {
      batches.push(val.slice(i, i + size));
    }
    return batches;
  };
}

/**
 * Resolves array of promises (if array is passed), otherwise passes value through.
 *
 * @example
 * ```ts
 * await _all()([Promise.resolve(1), Promise.resolve(2)]); // [1, 2]
 * await _all()(Promise.resolve(7)); // 7
 * ```
 */
export function _all<T = unknown>() {
  return (val: MaybePromise<T> | MaybePromise<T>[]): Promise<T | T[]> => {
    if (Array.isArray(val)) return Promise.all(val);
    return Promise.resolve(val);
  };
}

/**
 * Races all functions with the same input value, resolves with the first settled result.
 *
 * @example
 * ```ts
 * const res = await _race(
 *   (url: string) => fetchFromPrimary(url),
 *   (url: string) => fetchFromMirror(url),
 * )('/api/data'); // whichever answers first
 * ```
 */
export function _race<T = any, R = unknown>(...fns: ((arg: T) => MaybePromise<R>)[]) {
  return (val?: T): Promise<R> => Promise.race(fns.map((fn) => _invoke(fn, [val as T])));
}

/**
 * Value merged by `_use` - a factory returning a function is unwrapped one level,
 * so lazy producers ( eg. a deferred `_chain` wrapped in a thunk ) merge their result,
 * not the function itself.
 */
type Used<V> = V extends (...args: any[]) => infer U ? Awaited<U> : V;

/**
 * Evaluates `value` and merges the result into the accumulator object under `name`.
 * The merged value type is inferred, so downstream steps can destructure without annotations.
 *
 * When the factory resolves to a function, that function is called and its (awaited)
 * result is merged instead - allows lazy producers that defer the actual computation.
 *
 * An undefined / null accumulator starts a fresh context; a primitive accumulator
 * is an error - `_use` builds up an object context and would silently drop it.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   _use(() => Promise.resolve('service A'), 'a'),
 *   _use(() => Promise.resolve('service B'), 'b'),
 *   ({ a, b }) => `${a} + ${b}`,
 * ); // 'service A + service B'
 * ```
 */
export function _use<N extends string, V>(value: () => MaybePromise<V>, name: N): <A = object>(arg?: A) => Promise<Ctx<A> & Record<N, Used<V>>> {
  return async <A = object>(arg?: A): Promise<Ctx<A> & Record<N, Used<V>>> => {
    if (arg !== undefined && arg !== null && typeof arg !== 'object') {
      throw new Error(`_use expects an object accumulator, got ${typeof arg} - it would be silently dropped`);
    }

    let res: unknown = await _invoke(value, []);
    if (typeof res === 'function') {
      res = await (res as () => unknown)();
    }

    return Object.assign({}, arg, { [name]: res } as Record<N, Used<V>>) as Ctx<A> & Record<N, Used<V>>;
  };
}

/**
 * Evaluates all field functions in parallel with the chain input and merges the
 * results into the accumulator - a parallel, multi-key variant of `_use`.
 * Rejects as soon as any field rejects.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   _use(() => loadCampaign(id), 'campaign'),
 *   _struct({
 *     owner: (ctx) => loadOwner(ctx),
 *     stats: (ctx) => loadStats(ctx),
 *   }),
 * ); // { campaign, owner, stats } - owner and stats resolved in parallel
 * ```
 */
export function _struct<S extends Record<string, (input: any) => unknown>>(spec: S): <A = object>(arg?: A) => Promise<Ctx<A> & { [K in keyof S]: Awaited<ReturnType<S[K]>> }> {
  return async <A = object>(arg?: A) => {
    if (arg !== undefined && arg !== null && typeof arg !== 'object') {
      throw new Error(`_struct expects an object accumulator, got ${typeof arg} - it would be silently dropped`);
    }

    const keys = Object.keys(spec);
    const values = await Promise.all(keys.map((k) => _invoke(spec[k], [arg])));

    const merged = Object.assign({}, arg) as Record<string, unknown>;
    keys.forEach((k, i) => {
      merged[k] = values[i];
    });

    return merged as Ctx<A> & { [K in keyof S]: Awaited<ReturnType<S[K]>> };
  };
}

/**
 * Catches errors from a promise and calls the provided error handler.
 * Value returned from the handler becomes the recovery value of the chain.
 *
 * It acts also like circuit breaker, if error occures, it will not call next promise in chain.
 *
 * @example
 * ```ts
 * const res = await _catch(
 *   () => Promise.reject(new Error('boom')),
 *   async (err) => 'recovered',
 * )(); // 'recovered'
 * ```
 */
export function _catch<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, onError: (err: unknown, ...args: Args) => MaybePromise<E>) {
  return (...args: Args): Promise<R | E> => _invoke(promise, args).catch((err: unknown) => onError(err, ...args));
}

/**
 * Catch errors from a promise and call the provided error handler if the error matches the filter.
 * Errors not matching the filter are re-thrown.
 *
 * @example
 * ```ts
 * const res = await _catchFilter(
 *   () => Promise.reject(new Error('not found')),
 *   () => null,
 *   (err) => err instanceof Error && err.message === 'not found',
 * )(); // null - handled
 * ```
 */
export function _catchFilter<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, onError: (err: unknown) => MaybePromise<E>, filter: (err: unknown) => boolean) {
  return (...args: Args): Promise<R | E> =>
    _invoke(promise, args).catch((err: unknown) => {
      if (filter(err)) {
        return onError(err);
      } else {
        throw err;
      }
    });
}

/**
 * Catches rejections with a value strictly equal (`===`) to `value` and calls the error handler.
 * Other rejections are re-thrown.
 *
 * @example
 * ```ts
 * const res = await _catchValue(
 *   () => Promise.reject('E_NOT_FOUND'),
 *   () => 'default',
 *   'E_NOT_FOUND',
 * )(); // 'default'
 * ```
 */
export function _catchValue<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, onError: (err: unknown) => MaybePromise<E>, value: unknown) {
  return (...args: Args): Promise<R | E> => _invoke(promise, args).catch((err: unknown) => (err === value ? onError(err) : Promise.reject(err)));
}

/**
 * Catches exception of specific type and calls provided error handler.
 * Other exception types are re-thrown.
 *
 * @example
 * ```ts
 * class NotFoundError extends Error {}
 *
 * const res = await _catchException(
 *   () => Promise.reject(new NotFoundError()),
 *   (err) => null,
 *   NotFoundError,
 * )(); // null - handled, TypeError etc. would re-throw
 * ```
 */
export function _catchException<Args extends unknown[], R, E, X extends Error>(promise: (...args: Args) => MaybePromise<R>, onError: (err: X) => MaybePromise<E>, exception: Constructor<X>) {
  return (...args: Args): Promise<R | E> =>
    _invoke(promise, args).catch((err: unknown) => {
      if (err instanceof exception) {
        return onError(err);
      } else {
        throw err;
      }
    });
}

/**
 * Catches any error and resolves with the fallback value instead.
 *
 * @example
 * ```ts
 * const res = await _fallback(() => loadConfig(), () => defaultConfig)();
 * // defaultConfig when loadConfig fails
 * ```
 */
export function _fallback<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, fallback: (err: unknown) => MaybePromise<E>) {
  return (...args: Args): Promise<R | E> => _invoke(promise, args).catch(fallback);
}

/**
 * Calls the side-effect handler on error and re-throws it - the error still
 * propagates down the chain, unlike `_catch` which swallows it.
 *
 * @example
 * ```ts
 * await _tapError(
 *   () => saveUser(user),
 *   (err) => log.error(`save failed: ${err}`),
 * )(); // logs, then still rejects with the original error
 * ```
 */
export function _tapError<Args extends unknown[], R>(promise: (...args: Args) => MaybePromise<R>, onError: (err: unknown, ...args: Args) => unknown) {
  return (...args: Args): Promise<R> =>
    _invoke(promise, args).catch(async (err: unknown) => {
      await onError(err, ...args);
      throw err;
    });
}

/**
 * Runs cleanup after the wrapped function settles - on both success and failure.
 * Result (or error) of the wrapped function is passed through unchanged.
 *
 * @example
 * ```ts
 * const res = await _finally(
 *   () => db.query('...'),
 *   () => db.release(),
 * )(); // release runs whether query resolved or rejected
 * ```
 */
export function _finally<Args extends unknown[], R>(promise: (...args: Args) => MaybePromise<R>, cleanup: () => unknown) {
  return (...args: Args): Promise<R> => _invoke(promise, args).finally(() => cleanup());
}

/**
 * Runs side-effect steps and passes the input value through unchanged.
 * Steps execute sequentially - the first receives the tapped value, each
 * subsequent step receives the previous step's result. A failing side effect
 * rejects the chain.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => loadUser(1),
 *   _tap(
 *     (user) => log.info(`loaded ${user.id}`),
 *     () => audit.record('user-load'),
 *   ),
 * ); // resolves with the user, not the side effect results
 * ```
 */
export function _tap<T = unknown>(fn: (arg: T) => unknown, ...rest: Array<(arg: any) => unknown>): <A extends T>(arg: A) => Promise<A> {
  return <A extends T>(arg: A): Promise<A> => {
    const steps: Array<(arg?: unknown) => unknown> = [fn as (arg?: unknown) => unknown, ...rest];
    return _reduceSteps(Promise.resolve(arg as unknown), steps).then(() => arg);
  };
}

/**
 * Branches the chain - when the (possibly async) condition is truthy calls `onTrue`,
 * otherwise `onFalse`. When `onFalse` is omitted and the condition is falsy,
 * the input value passes through unchanged.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => loadUser(1),
 *   _ifElse(
 *     (user) => user.isActive,
 *     (user) => grantAccess(user),
 *     (user) => denyAccess(user),
 *   ),
 * );
 * ```
 */
export function _ifElse<T, A, B = T>(cond: (arg: T) => MaybePromise<unknown>, onTrue: (arg: T) => MaybePromise<A>, onFalse?: (arg: T) => MaybePromise<B>) {
  return (arg: T): Promise<A | B> => {
    const branch = (res: unknown): Promise<A | B> => {
      if (res) {
        return Promise.resolve(onTrue(arg));
      }
      return onFalse ? Promise.resolve(onFalse(arg)) : (Promise.resolve(arg) as Promise<unknown> as Promise<B>);
    };

    const r = cond(arg);
    if (isPromise(r)) {
      return r.then(branch);
    }

    return branch(r);
  };
}

/**
 * Runs `fn` when the (possibly async) condition is truthy, otherwise passes the input value through.
 * One-sided `_ifElse`.
 *
 * @example
 * ```ts
 * await _when((v: number) => v > 5, (v) => v * 2)(10); // 20
 * await _when((v: number) => v > 5, (v) => v * 2)(3);  // 3 - passed through
 * ```
 */
export function _when<T, R>(cond: (arg: T) => MaybePromise<unknown>, fn: (arg: T) => MaybePromise<R>) {
  return (arg: T): Promise<T | R> => {
    const branch = (res: unknown): Promise<T | R> => (res ? Promise.resolve(fn(arg)) : Promise.resolve(arg));

    const r = cond(arg);
    if (isPromise(r)) {
      return r.then(branch);
    }

    return branch(r);
  };
}

/**
 * Runs `fn` when the (possibly async) condition is falsy, otherwise passes the input value through.
 * Inverse of `_when`.
 *
 * @example
 * ```ts
 * await _unless((v: number) => v > 5, (v) => v * 2)(3);  // 6
 * await _unless((v: number) => v > 5, (v) => v * 2)(10); // 10 - passed through
 * ```
 */
export function _unless<T, R>(cond: (arg: T) => MaybePromise<unknown>, fn: (arg: T) => MaybePromise<R>) {
  return (arg: T): Promise<T | R> => {
    const branch = (res: unknown): Promise<T | R> => (res ? Promise.resolve(arg) : Promise.resolve(fn(arg)));

    const r = cond(arg);
    if (isPromise(r)) {
      return r.then(branch);
    }

    return branch(r);
  };
}

/**
 * Resolves with the default value when the chained value is `null` or `undefined`.
 * Default can be a plain value or a (possibly async) factory function.
 * Other falsy values (`0`, `''`, `false`) are kept.
 *
 * @example
 * ```ts
 * await _chain(() => findUser(id), _orElse(guestUser)); // guestUser when null
 * await _orElse(async () => loadDefault())(undefined);  // lazy async default
 * await _orElse('def')(0); // 0 - only null/undefined replaced
 * ```
 */
export function _orElse<T, D>(defaultValue: D | (() => MaybePromise<D>)) {
  return (arg?: T): Promise<T | D> => {
    if (arg !== null && arg !== undefined) {
      return Promise.resolve(arg);
    }

    if (typeof defaultValue === 'function') {
      return _invoke(defaultValue as () => MaybePromise<D>, []);
    }

    return Promise.resolve(defaultValue);
  };
}

/**
 * Wraps a single value in an array, arrays are passed through unchanged.
 *
 * @example
 * ```ts
 * _toArray()(5);      // [5]
 * _toArray()([1, 2]); // [1, 2] - same reference
 * ```
 */
export function _toArray<T>(): (args: T | T[]) => T[] {
  return (args: T | T[]) => (Array.isArray(args) ? args : [args]);
}

/**
 * Options for `_retry`.
 */
export interface RetryOptions {
  /**
   * Total number of attempts, including the first one. Default 3.
   */
  attempts?: number;

  /**
   * Base delay between attempts in milliseconds. Default 100.
   */
  delay?: number;

  /**
   * How the delay grows across attempts. Default 'fixed'.
   */
  backoff?: 'fixed' | 'exponential';

  /**
   * Retry only errors matching the predicate. Default: retry every error.
   */
  retryIf?: (err: unknown) => boolean;
}

/**
 * Retries the wrapped function until it succeeds or attempts are exhausted.
 * Thin fp-shaped adapter over the resilience `retryStrategy` - for jitter,
 * max delay caps or result-based retries use `ResiliencePipelineBuilder` directly.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   _retry(() => fetchRates(), { attempts: 3, delay: 200, backoff: 'exponential' }),
 *   (rates) => rates.eur,
 * );
 * ```
 */
export function _retry<Args extends unknown[], R>(fn: (...args: Args) => MaybePromise<R>, options: RetryOptions = {}) {
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`_retry attempts must be a positive integer, got ${attempts}`);
  }

  const delay = options.delay ?? 100;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error(`_retry delay must be a non-negative number of milliseconds, got ${delay}`);
  }

  const retryIf = options.retryIf;
  const strategy = retryStrategy<R>({
    MaxRetryAttempts: attempts - 1,
    Delay: TimeSpan.fromMilliseconds(delay),
    BackoffType: options.backoff === 'exponential' ? BackoffType.Exponential : BackoffType.Constant,
    ShouldHandle: retryIf ? (o: Outcome<R>) => o.Error !== undefined && retryIf(o.Error) : undefined,
  });

  return (...args: Args): Promise<R> => {
    const controller = new AbortController();
    return strategy(() => _invoke(fn, args))({ Signal: controller.signal, Properties: new Map<string, unknown>() });
  };
}

/**
 * Rejects with `TimeoutRejectedException` when the wrapped function does not
 * settle within `ms` milliseconds. The underlying operation is NOT interrupted -
 * it keeps running orphaned (plain promises are not cancelable). For cooperative
 * cancellation use `ResiliencePipelineBuilder` with a signal-aware callback.
 *
 * @example
 * ```ts
 * const res = await _timeout(() => fetchSlowService(), 5000)();
 * ```
 */
export function _timeout<Args extends unknown[], R>(fn: (...args: Args) => MaybePromise<R>, ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`_timeout duration must be a positive number of milliseconds, got ${ms}`);
  }

  const strategy = timeoutStrategy<R>(TimeSpan.fromMilliseconds(ms));

  return (...args: Args): Promise<R> => {
    const controller = new AbortController();
    return strategy(() => _invoke(fn, args))({ Signal: controller.signal, Properties: new Map<string, unknown>() });
  };
}

/**
 * Waits `ms` milliseconds, then passes the input value through unchanged.
 * Step-shaped variant of `sleep` for use inside chains.
 *
 * @example
 * ```ts
 * await _chain(() => save(record), _sleep(500), () => verify(record));
 * ```
 */
export function _sleep(ms: number): <A>(arg: A) => Promise<A> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`_sleep duration must be a non-negative number of milliseconds, got ${ms}`);
  }

  return <A>(arg: A): Promise<A> => sleep(TimeSpan.fromMilliseconds(ms)).then(() => arg);
}
