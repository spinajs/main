import { isPromise } from 'util/types';

export type Constructor<T> = new (...args: any[]) => T;

/**
 * Chains a list of functions together, passing the result of each function to the next.
 *
 * @param fns
 * @returns
 */
export function _chain<T>(...fns: (((arg?: any) => Promise<any>) | any | Promise<any>)[]): Promise<T> {
  return fns.reduce((prev: Promise<T>, curr) => {
    if (curr instanceof Promise) {
      return prev.then(() => curr);
    } else if (typeof curr === 'function') {
      return prev.then((res) => (curr as (arg?: any) => Promise<T>)(res));
    } else {
      return prev.then(() => Promise.resolve(curr));
    }
  }, Promise.resolve(null));
}

export function _zip(...fns: ((arg?: any) => Promise<any>)[]) {
  return (val: unknown) => Promise.all(fns.map((fn) => fn(val)));
}

export function _map<T, R>(callback: (val: T) => Promise<R>) {
  return (val: T[]) => val.map((v) => callback(v));
}

export function _all() {
  return (val: Promise<unknown> | Promise<unknown>[]) => {
    if (Array.isArray(val)) return Promise.all(val);
    return val;
  };
}

export function _use(value: () => Promise<unknown>, name: string) {
  return async (arg?: unknown) => Object.assign({}, arg, { [name]: await value() });
}

/**
 *
 * Catches errors from a promise and calls the provided error handler.
 * If error occures, chained promise will be rejected with the error.
 *
 * It acts also like circuit breaker, if error occures, it will not call next promise in chain.
 *
 * @param promise
 * @param onError
 * @returns
 */
export function _catch(promise: (...arg: unknown[]) => Promise<unknown>, onError: (err: Error, ...arg: unknown[]) => Promise<void>) {
  return (...arg: unknown[]) => Promise.resolve(promise(...arg)).catch(async (err) => await onError(err, ...arg));
}

/**
 * Catch errors from a promise and call the provided error handler if the error matches the filter.
 *
 * @param promise
 * @param onError
 * @param filter
 * @returns
 */
export function _catchFilter(promise: (arg: unknown) => Promise<unknown>, onError: (err: Error) => void, filter: (err: Error) => boolean) {
  return (arg?: unknown) =>
    Promise.resolve(promise(arg)).catch((err) => {
      if (filter(err)) {
        return onError(err);
      } else {
        throw err;
      }
    });
}

export function _catchValue(promise: (arg: unknown) => Promise<unknown>, onError: (err: Error) => unknown, value: unknown) {
  return (arg?: unknown) => Promise.resolve(promise(arg)).catch((err) => (err === value ? onError(err) : Promise.reject(err)));
}

/**
 * Cactches exception of specific type and calls provided error handler.
 *
 * @param promise
 * @param onError
 * @param exception
 * @returns
 */
export function _catchException(promise: (arg: unknown) => Promise<unknown>, onError: (err: Error) => void, exception: Constructor<Error>) {
  return (arg?: unknown) =>
    Promise.resolve(promise(arg)).catch((err) => {
      if (typeof err === 'object' && err instanceof exception) {
        return onError(err);
      } else {
        throw err;
      }
    });
}

export function _fallback(promise: (arg: unknown) => Promise<unknown>, fallback: (err: Error) => unknown) {
  return (arg?: unknown) => promise(arg).catch(fallback);
}

export function _tap(promise: ((arg: any) => Promise<unknown>) | Promise<unknown>) {
  return (arg?: unknown) => {
    if (promise instanceof Promise) {
      return promise.then(() => arg);
    }

    return promise(arg).then(() => arg);
  };
}

export function _either(cond: (arg: unknown) => Promise<unknown> | boolean, onFulfilled: (a?: unknown) => Promise<unknown>, onRejected: (arg?: unknown) => Promise<unknown>) {
  return (arg?: unknown) => {
    const r = cond(arg);
    if (isPromise(r)) {
      return r.then((res: unknown) => (res ? onFulfilled(arg) : onRejected ? onRejected(arg) : null));
    }

    r ? onFulfilled(arg) : onRejected(arg);
  };
}
