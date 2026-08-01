/**
 * Type guard for native promises.
 *
 * Deliberately strict - NOT duck-typed. Awaitable objects that expose `.then`
 * without being promises ( eg. orm query builders ) must not be detected here:
 * DI and other consumers use this guard to decide whether to await a resolved
 * value, and `.then` on a query builder executes the query. Use `isThenable`
 * when promise-like values from other realms / libraries should match too.
 *
 * @param value - value to test
 * @returns true if `value` is a native `Promise`
 */
export function isPromise(value: any): value is Promise<any> {
  return value instanceof Promise;
}

/**
 * Type guard for promise-like values (thenables) - native promises, promises
 * from other realms or promise libraries, and any awaitable object.
 *
 * NOTE: matches awaitable query builders as well - calling `.then` on those
 * executes them. Use `isPromise` when only native promises should match.
 *
 * @param value - value to test
 * @returns true if `value` exposes a callable `then`
 */
export function isThenable(value: any): value is PromiseLike<any> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/**
 * Type guard narrowing away `null` and `undefined`.
 *
 * @param value - value to test
 * @returns true if `value` is neither `null` nor `undefined`
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Type guard for functions.
 *
 * @param value - value to test
 * @returns true if `value` is callable
 */
export function isFunction(value: unknown): value is (...args: any[]) => unknown {
  return typeof value === 'function';
}
