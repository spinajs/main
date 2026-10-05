import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

/**
 * @internal The 2.x service a config key names (`<path>.service`), for the deprecated 2.x code.
 *
 * users no longer ships those keys, and the authn packages ship the same paths with 3.0 shapes (an object without
 * `service`, or a name of their own type). So a missing key, or a name not registered for the 2.x `type`, resolves
 * `type` itself: the last registration, which is users' 2.x default unless the application registered its own.
 * Synchronous for a type that is not an `AsyncService`.
 */
export function legacyService<T>(path: string, type: Class<T>): T | Promise<T> {
  const named = DI.get(Configuration)?.get<unknown>(`${path}.service`);
  const chosen = typeof named === 'string' ? DI.getRegisteredTypes(type).find((t) => t.name === named) : undefined;

  return DI.resolve(chosen ?? type) as T | Promise<T>;
}

/**
 * @internal Keeps a config service name that N8c renamed (`SlidingExpiration` → `LegacySlidingExpiration`) naming
 * the renamed 2.x class under `base`, for `legacyService`, which picks a registration of `base` by its `name`. A
 * factory, not a class: DI keys classes by name, and a class of that name would clash with authn-session's again.
 * Register it before the classes, so a plain resolve of `base` still gets the last registered class. R1 deletes it.
 */
export function registerRenamedService(base: Class<unknown>, oldName: string, renamed: () => Class<unknown>): void {
  const factory = (container: IContainer) => container.resolve(renamed());
  Object.defineProperty(factory, 'name', { value: oldName });
  DI.register(factory).as(base);
}

/**
 * @internal Gives the 2.x `@AutoinjectService(path)` fields (users-http, the 2.x authn-http controllers) the same
 * fallback as `legacyService`: those fields throw `ServiceNotFound` at controller resolution unless a registration
 * of `base` has the configured name, and the name is usually a 3.0 store's (`MemorySessionStore`, `DbSessionStore`,
 * ...) that only authn-session's base carries. So this factory takes the configured name whenever no real
 * registration of `base` has it, and resolves `base` itself (its last registered class). Register it before the
 * classes. R1 deletes it.
 */
export function registerConfiguredFallback(base: Class<unknown>, path: string): void {
  const factory = (container: IContainer) => container.resolve(base);
  Object.defineProperty(factory, 'name', {
    get: () => {
      const named = DI.get(Configuration)?.get<unknown>(`${path}.service`);
      const carried = typeof named === 'string' && (DI.getRegisteredTypes(base) ?? []).some((t) => t !== factory && t.name === named);

      return typeof named === 'string' && !carried ? named : '';
    },
  });
  DI.register(factory).as(base);
}
