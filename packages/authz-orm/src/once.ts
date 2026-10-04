import { AuthzConfigError } from '@spinajs/authz';

const KEY = Symbol.for('@spinajs/authz-orm');
const MARK = Object.freeze({ package: '@spinajs/authz-orm' });

/**
 * Two copies of this package (two installs, or its ESM and CJS builds) keep two registries while DI
 * keeps one middleware, and the second copy would leave the orm's builders unwrapped: refuse it.
 */
export function claimProcess(store: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>, mark: object = MARK): void {
  const held = store[KEY];
  if (held !== undefined && held !== mark) throw new AuthzConfigError('authz-orm: another copy of @spinajs/authz-orm is already loaded in this process; load it once, in one module format');
  store[KEY] = mark;
}

claimProcess();
