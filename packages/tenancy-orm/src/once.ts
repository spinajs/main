import { InvalidOperation } from '@spinajs/exceptions';

const KEY = Symbol.for('@spinajs/tenancy-orm');
const MARK = Object.freeze({ package: '@spinajs/tenancy-orm' });

/**
 * Two copies of this package keep two model registries while DI keeps one TenantScopeMiddleware, so the models of
 * the second copy would run unfiltered: refuse it.
 */
export function claimProcess(store: object = globalThis, mark: object = MARK): void {
  const held: unknown = Reflect.get(store, KEY);
  if (held !== undefined && held !== mark) throw new InvalidOperation('tenancy-orm: another copy of @spinajs/tenancy-orm is already loaded in this process; load it once');
  Reflect.set(store, KEY, mark);
}

claimProcess();
