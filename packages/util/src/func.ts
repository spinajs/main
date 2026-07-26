/**
 * Wraps callback function into lazy statement.
 *
 * Callback execution will be delayed
 */
export class Lazy<T> {
    constructor(protected callback: () => T) {
    }

    public static oF<T>(callback: () => T) {
        return new Lazy(callback);
    }

    public call(context : unknown): T {
        return this.callback?.call(context);
    }
}

/** A function that does nothing and returns `undefined`. */
export function noop(): void {
  /* intentionally empty */
}

/** Returns its argument unchanged. */
export function identity<T>(value: T): T {
  return value;
}

/**
 * Wraps a function so it runs at most once; subsequent calls return the first result.
 *
 * @param fn - function to guard
 * @returns a function returning the memoized first result
 * @example
 * const init = once(() => expensiveSetup());
 * init(); init(); // expensiveSetup runs exactly once
 */
export function once<T>(fn: () => T): () => T {
  let called = false;
  let result: T;
  return () => {
    if (!called) {
      called = true;
      result = fn();
    }
    return result;
  };
}

/**
 * Memoizes a single-argument function, caching results by a derived key
 * ( defaults to the argument itself ).
 *
 * @param fn - function to memoize
 * @param keyFn - maps the argument to a cache key ( default: identity )
 * @returns a memoized function backed by a `Map`
 * @example
 * const fib = memoize((n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2)));
 */
export function memoize<A, R>(fn: (arg: A) => R, keyFn: (arg: A) => unknown = identity): (arg: A) => R {
  const cache = new Map<unknown, R>();
  return (arg: A) => {
    const key = keyFn(arg);
    if (cache.has(key)) {
      return cache.get(key) as R;
    }
    const result = fn(arg);
    cache.set(key, result);
    return result;
  };
}