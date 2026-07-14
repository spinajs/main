/**
 * Type guard for native promises.
 *
 * @param value - value to test
 * @returns true if `value` is a `Promise`
 */
export function isPromise(value: any): value is Promise<any> {
  return value instanceof Promise;
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
