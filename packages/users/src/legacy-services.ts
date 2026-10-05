import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

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
