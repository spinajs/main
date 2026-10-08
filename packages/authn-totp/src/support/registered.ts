import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

/**
 * `DI.check` stays true once `DI.unregister` has emptied a registration, and a failed resolve of an abstract class
 * leaves the class itself behind, so this counts only other registered types.
 */
export function registered(type: abstract new (...args: never[]) => unknown): boolean {
  return (DI.getRegisteredTypes(type as unknown as Class<unknown>) ?? []).some((t) => t !== (type as unknown));
}
