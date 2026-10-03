import { SYSTEM, runWithPrincipal } from '@spinajs/authz';

/** Runs `fn` as SYSTEM, so the authz query middleware leaves its queries unscoped. */
export const asSystem = <T>(fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(SYSTEM, async () => fn());

/** A mocha test whose body runs as SYSTEM, for suites that test the compiler or the adapter rather than the middleware. */
export const systemIt = (title: string, fn: (this: Mocha.Context) => unknown): Mocha.Test =>
  globalThis.it(title, function (this: Mocha.Context) {
    return asSystem(() => fn.call(this));
  });
