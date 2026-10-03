import { AuthzConfigError } from '@spinajs/authz';

/**
 * Policies and native compilers write SQL into the builder they are handed while the residual
 * compiles, which is synchronous. An async one would write after the statement rendered, leaving an
 * empty group that reads as TRUE, so its promise is refused instead of ignored.
 */
export function assertSynchronous(result: unknown, what: string): void {
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    (result as Promise<unknown>).then(undefined, () => undefined);
    throw new AuthzConfigError(`authz-orm: ${what} returned a promise; it must add its conditions synchronously`);
  }
}
