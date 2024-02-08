/**
 * Chains a list of functions together, passing the result of each function to the next.
 *
 * @param fns
 * @returns
 */
export function _chain<T>(...fns: ((arg?: unknown) => Promise<unknown>)[]): Promise<T> {
  return fns.reduce((prev, curr) => {
    return prev.then((res) => curr(res));
  }, Promise.resolve(null));
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
  return (arg: unknown) => promise(arg).catch(onError);
}
