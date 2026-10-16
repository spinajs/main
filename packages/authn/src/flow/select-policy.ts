import type { IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { isPlainObject } from '@spinajs/util';

import { MfaPolicy } from '../contracts/mfa.js';
import { q } from '../support/format.js';

/** `authn.mfa.policy.service` (schema default DefaultMfaPolicy); the registration nearest to `container` wins. */
export async function selectMfaPolicy(container: IContainer, name: string): Promise<MfaPolicy> {
  const names = container.getRegisteredNames(MfaPolicy);
  if (!names.includes(name)) {
    throw new InvalidOption(`authn.mfa.policy.service ${q(name)}: no MfaPolicy is registered under that name (registered: ${names.map(q).join(', ') || 'none'})`);
  }
  const policy: unknown = await container.resolveNamed(MfaPolicy, name);
  if (!isPlainObject(policy) || typeof policy.required !== 'function' || typeof policy.steps !== 'function') throw new InvalidOption(`authn.mfa.policy.service ${q(name)} is not an MfaPolicy`);
  return policy as unknown as MfaPolicy;
}
