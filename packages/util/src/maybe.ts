import type { MaybePromise } from './fp.js';
import { isThenable } from './types.js';

/**
 * Runs `next` on `value` right away, or once it resolves when it is a promise or another thenable. Keeps a code path
 * synchronous while every input is, instead of paying a microtask per step as `await` does.
 *
 * @example
 * thenMaybe(cache.get(key) ?? load(key), (row) => row.name); // a string, or a Promise<string> after a load
 */
export function thenMaybe<T, U>(value: T | PromiseLike<T>, next: (value: T) => MaybePromise<U>): MaybePromise<U> {
  return isThenable(value) ? Promise.resolve(value).then(next) : next(value as T);
}

/**
 * `Promise.all` that stays synchronous: the values themselves when none is a thenable, else a promise of them all.
 *
 * @example
 * allMaybe([1, Promise.resolve(2)]); // Promise<[1, 2]>
 * allMaybe([1, 2]);                  // [1, 2]
 */
export function allMaybe<const T extends readonly unknown[]>(values: T): MaybePromise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  type Out = { -readonly [K in keyof T]: Awaited<T[K]> };
  if (!values.some(isThenable)) return [...values] as Out;
  return Promise.all(values) as Promise<Out>;
}
