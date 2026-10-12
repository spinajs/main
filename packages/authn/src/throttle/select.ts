import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { isPlainObject } from '@spinajs/util';

import { AuthnThrottle } from '../contracts/throttle.js';
import { instantiate, nearestRegistration, q, registeredNames } from '../registry/named.js';

const MEMORY_THROTTLE = 'MemoryAuthnThrottle';


/**
 * The throttle `name` (authn.throttle.service) registers in the lineage of `container`; when unset, the only registered
 * throttle, or the only one besides `MemoryAuthnThrottle`. Throws when none fits, never falling back to memory.
 */
export async function selectAuthnThrottle(container: IContainer, name: string | undefined): Promise<AuthnThrottle> {
  const names = registeredNames(container, AuthnThrottle);
  const listed = names.map(q).join(', ') || 'none';
  if (name === undefined) {
    // The core always registers the memory throttle; one more registered throttle is the one the app imported (K6).
    const others = names.filter((n) => n !== MEMORY_THROTTLE);
    const only = names.length === 1 ? names : others.length === 1 ? others : [];
    if (only.length !== 1) {
      throw new InvalidOption(`authn.throttle.service is not set and ${names.length === 0 ? 'no AuthnThrottle is' : 'several are'} registered (${listed}); name one`);
    }
    name = only[0];
  }
  const type = nearestRegistration(container, AuthnThrottle, name);
  if (!type) {
    throw new InvalidOption(`authn.throttle.service ${q(name)}: no AuthnThrottle is registered under that name (registered: ${listed}). Install the package that provides it (DbAuthnThrottle: @spinajs/authn-orm); MemoryAuthnThrottle suits a single instance only`);
  }
  const throttle: unknown = await instantiate(container, type);
  if (!isPlainObject(throttle) || typeof throttle.attempt !== 'function' || typeof throttle.succeed !== 'function') {
    throw new InvalidOption(`authn.throttle.service ${q(name)} is not an AuthnThrottle`);
  }
  return throttle as unknown as AuthnThrottle;
}
