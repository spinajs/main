import { isPromise } from './types.js';

export type Constructor<T> = new (...args: any[]) => T;

/**
 * Value that may be wrapped in a promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Step accepted by `_chain` / `_pipe`: a function receiving the previous result,
 * a promise, or a plain value.
 */
export type ChainStep = ((arg?: any) => unknown) | Promise<unknown> | unknown;

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

function _reduceSteps(initial: Promise<unknown>, fns: ChainStep[]): Promise<unknown> {
  return fns.reduce<Promise<unknown>>((prev, curr) => {
    if (typeof curr === 'function') {
      return prev.then((res) => (curr as (arg?: unknown) => unknown)(res));
    } else if (isPromise(curr)) {
      // eager promise - if an earlier step failed it would never be observed,
      // suppress its rejection to avoid unhandled rejection warnings
      return prev.then(
        () => curr,
        (err) => {
          curr.catch(() => null);
          throw err;
        },
      );
    }

    return prev.then(() => curr);
  }, initial);
}

/**
 * Chains a list of functions together, passing the result of each function to the next.
 * Executes eagerly - for a reusable, lazy pipeline see `_pipe`.
 *
 * Steps can be functions (sync or async), promises or plain values.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => Promise.resolve(1),
 *   (v: number) => v + 1,
 *   (v: number) => Promise.resolve(v * 2),
 * ); // 4
 *
 * // plain values and promises are valid steps too
 * await _chain(5, (v: number) => v + 1); // 6
 * ```
 *
 * @param fns
 * @returns
 */
export function _chain<T = unknown>(...fns: ChainStep[]): Promise<T> {
  return _reduceSteps(Promise.resolve(null), fns) as Promise<T>;
}

/**
 * Lazy variant of `_chain` - composes steps into a reusable function.
 * The argument passed to the composed function is fed into the first step.
 *
 * @example
 * ```ts
 * const pipeline = _pipe((v: number) => v + 1, (v: number) => v * 2);
 * await pipeline(2); // 6
 * await pipeline(5); // 12
 * ```
 *
 * @param fns
 * @returns
 */
export function _pipe<T = unknown>(...fns: ChainStep[]): (arg?: unknown) => Promise<T> {
  return (arg?: unknown) => _reduceSteps(Promise.resolve(arg), fns) as Promise<T>;
}

/**
 * Runs all functions with the same input value, resolves with an array of results.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   2,
 *   _zip(
 *     async (v: number) => v + 1,
 *     async (v: number) => v * 10,
 *   ),
 * ); // [3, 20]
 * ```
 */
export function _zip<T = any, F extends ((arg: T) => unknown)[] = ((arg: T) => unknown)[]>(...fns: F) {
  return (val: T): Promise<{ [K in keyof F]: Awaited<ReturnType<F[K]>> }> => Promise.all(fns.map((fn) => _invoke(fn, [val]))) as Promise<{ [K in keyof F]: Awaited<ReturnType<F[K]>> }>;
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
 *
 * // in a chain
 * await _chain(() => [1, 2, 3, 4], _filter((v: number) => v > 2)); // [3, 4]
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
 * Maps every element of the input array with at most `concurrency` callbacks
 * running at the same time - middle ground between `_sequence` (one at a time)
 * and `_map` (all at once). Order of results is preserved regardless of
 * completion order.
 *
 * @example
 * ```ts
 * // at most 2 requests in flight at any moment
 * const res = await _concurrent(async (id: number) => fetchUser(id), 2)([1, 2, 3, 4, 5]);
 *
 * // in a chain
 * await _chain(() => ids, _concurrent((id: number) => fetchUser(id), 4));
 * ```
 */
export function _concurrent<T, R>(callback: (val: T) => MaybePromise<R>, concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`_concurrent concurrency must be a positive integer, got ${concurrency}`);
  }

  return (val: T[]): Promise<R[]> => {
    if (!Array.isArray(val)) {
      throw new Error(`_concurrent expects an array, got ${typeof val}`);
    }

    const result: R[] = new Array<R>(val.length);
    let next = 0;

    const worker = async () => {
      while (next < val.length) {
        const i = next++;
        result[i] = await callback(val[i]);
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
 *
 * // process 100 records at a time, one batch after another
 * await _chain(
 *   () => records,
 *   _batch(100),
 *   _sequence((batch: Record[]) => db.insert(batch)),
 * );
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
  return (val: T): Promise<R> => Promise.race(fns.map((fn) => _invoke(fn, [val])));
}

/**
 * Evaluates `value` and merges the result into the accumulator object under `name`.
 *
 * NOTE: non-object accumulator values are dropped - `_use` is meant to build up
 * an object context, previous primitive results are not carried over.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   _use(() => Promise.resolve('service A'), 'a'),
 *   _use(() => Promise.resolve('service B'), 'b'),
 *   ({ a, b }: { a: string; b: string }) => `${a} + ${b}`,
 * ); // 'service A + service B'
 * ```
 */
export function _use<N extends string, A extends object = object>(value: () => unknown, name: N) {
  return async (arg?: A): Promise<A & Record<N, unknown>> => {
    const res = await _chain(value());
    return Object.assign({}, arg, { [name]: res } as Record<N, unknown>) as A & Record<N, unknown>;
  };
}

/**
 *
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
 *
 * // sync throws are caught too
 * await _catch(() => { throw new Error('boom'); }, async () => 'recovered')(); // 'recovered'
 * ```
 *
 * @param promise
 * @param onError
 * @returns
 */
export function _catch<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, onError: (err: Error, ...args: Args) => MaybePromise<E>) {
  return (...args: Args): Promise<R | E> => _invoke(promise, args).catch((err: Error) => onError(err, ...args));
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
 *   (err) => err.message === 'not found',
 * )(); // null - handled
 * ```
 *
 * @param promise
 * @param onError
 * @param filter
 * @returns
 */
export function _catchFilter<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, onError: (err: Error) => MaybePromise<E>, filter: (err: Error) => boolean) {
  return (...args: Args): Promise<R | E> =>
    _invoke(promise, args).catch((err: Error) => {
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
 *
 * @param promise
 * @param onError
 * @param exception
 * @returns
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
 * const res = await _chain(
 *   _use(_fallback(() => loadConfig(), () => defaultConfig), 'cfg'),
 *   ({ cfg }) => cfg,
 * ); // defaultConfig when loadConfig fails
 * ```
 */
export function _fallback<Args extends unknown[], R, E>(promise: (...args: Args) => MaybePromise<R>, fallback: (err: Error) => MaybePromise<E>) {
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
 *   (err) => log.error(`save failed: ${err.message}`),
 * )(); // logs, then still rejects with the original error
 * ```
 */
export function _tapError<Args extends unknown[], R>(promise: (...args: Args) => MaybePromise<R>, onError: (err: Error, ...args: Args) => unknown) {
  return (...args: Args): Promise<R> =>
    _invoke(promise, args).catch(async (err: Error) => {
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
 * Runs the side effect (function or promise) and passes the input value through unchanged.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => loadUser(1),
 *   _tap((user) => log.info(`loaded ${user.id}`)),
 * ); // resolves with the user, not the log result
 * ```
 */
export function _tap<T>(sideEffect: ((arg: T) => unknown) | Promise<unknown>) {
  return (arg?: T): Promise<T> => {
    if (typeof sideEffect === 'function') {
      return _invoke(sideEffect, [arg as T]).then(() => arg as T);
    }

    return sideEffect.then(() => arg as T);
  };
}

/**
 * Branches the chain - when the (possibly async) condition is truthy calls `onFulfilled`,
 * otherwise `onRejected`. When `onRejected` is omitted and condition is falsy, resolves with `null`.
 *
 * @example
 * ```ts
 * const res = await _chain(
 *   () => loadUser(1),
 *   _either(
 *     async (user) => user.isActive,
 *     async (user) => grantAccess(user),
 *     async (user) => denyAccess(user),
 *   ),
 * );
 * ```
 */
export function _either<T = unknown, A = unknown, B = unknown>(cond: (arg: T) => MaybePromise<unknown>, onFulfilled: (arg?: T) => MaybePromise<A>, onRejected?: (arg?: T) => MaybePromise<B>) {
  return (arg?: T): Promise<A | B | null> => {
    const branch = (res: unknown): Promise<A | B | null> => {
      if (res) {
        return Promise.resolve(onFulfilled(arg));
      }
      return onRejected ? Promise.resolve(onRejected(arg)) : Promise.resolve(null);
    };

    const r = cond(arg as T);
    if (isPromise(r)) {
      return r.then(branch);
    }

    return branch(r);
  };
}

/**
 * Runs `fn` when the (possibly async) condition is truthy, otherwise passes the input value through.
 * One-sided `_either`.
 *
 * @example
 * ```ts
 * await _when((v: number) => v > 5, (v: number) => v * 2)(10); // 20
 * await _when((v: number) => v > 5, (v: number) => v * 2)(3);  // 3 - passed through
 * ```
 */
export function _when<T = unknown, R = unknown>(cond: (arg: T) => MaybePromise<unknown>, fn: (arg: T) => MaybePromise<R>) {
  return (arg?: T): Promise<T | R> => {
    const branch = (res: unknown): Promise<T | R> => (res ? Promise.resolve(fn(arg as T)) : Promise.resolve(arg as T));

    const r = cond(arg as T);
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
 * await _unless((v: number) => v > 5, (v: number) => v * 2)(3);  // 6
 * await _unless((v: number) => v > 5, (v: number) => v * 2)(10); // 10 - passed through
 * ```
 */
export function _unless<T = unknown, R = unknown>(cond: (arg: T) => MaybePromise<unknown>, fn: (arg: T) => MaybePromise<R>) {
  return (arg?: T): Promise<T | R> => {
    const branch = (res: unknown): Promise<T | R> => (res ? Promise.resolve(arg as T) : Promise.resolve(fn(arg as T)));

    const r = cond(arg as T);
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
 * await _chain(() => findUser(id), _or_else(guestUser)); // guestUser when null
 * await _or_else(async () => loadDefault())(undefined);  // lazy async default
 * await _or_else('def')(0); // 0 - only null/undefined replaced
 * ```
 */
export function _or_else<T, D>(defaultValue: D | (() => MaybePromise<D>)) {
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
 * _to_array()(5);      // [5]
 * _to_array()([1, 2]); // [1, 2] - same reference
 * ```
 */
export function _to_array<T>(): (args: T | T[]) => T[] {
  return (args: T | T[]) => (Array.isArray(args) ? args : [args]);
}
