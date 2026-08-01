/**
 * Type guard for promises and promise-like values (thenables).
 *
 * Uses duck-typing so promises from other realms or promise libraries
 * are detected as well, not only native `Promise` instances.
 *
 * @param value - value to test
 * @returns true if `value` is a `Promise` or a thenable
 */
export function isPromise(value: any): value is Promise<any> {
  return value instanceof Promise || (!!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function');
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
