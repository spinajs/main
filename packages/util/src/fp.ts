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
export function _catch(promise: (arg: unknown) => Promise<unknown>, onError: (err: Error) => void) {
  return (arg?: unknown) => promise(arg).catch(onError);
}

export function _fallback(promise: (arg: unknown) => Promise<unknown>, fallback: (err: Error) => unknown) {
  return (arg?: unknown) => promise(arg).catch(fallback);
}

export function _tap(promise: ((arg: unknown) => Promise<unknown>) | Promise<unknown> ) {
  return (arg?: unknown) => {
    if(promise instanceof Promise) {
      return promise.then(() => arg);
    }

    return promise(arg).then(() => arg);
  }
}
