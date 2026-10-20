import type { INamedServiceOptions } from '@spinajs/configuration';
import { isPlainObject } from '@spinajs/util';

import type { AuthnThrottle } from '../contracts/throttle.js';

const MEMORY_THROTTLE = 'MemoryAuthnThrottle';

/** K6: the only registered throttle, or the only one besides MemoryAuthnThrottle, which the core always registers; never a fallback to memory. */
export function pickAuthnThrottle(registered: readonly string[]): string | undefined {
  if (registered.length === 1) return registered[0];
  const others = registered.filter((n) => n !== MEMORY_THROTTLE);
  return others.length === 1 ? others[0] : undefined;
}

/** `authn.throttle.service`, resolved by `@AutoinjectNamedService` and `resolveNamedService`. */
export const AUTHN_THROTTLE_SERVICE: INamedServiceOptions<AuthnThrottle> = {
  default: pickAuthnThrottle,
  is: (t) => isPlainObject(t) && typeof t.attempt === 'function' && typeof t.succeed === 'function',
};
