import type { INamedServiceOptions } from '@spinajs/configuration';
import { isPlainObject } from '@spinajs/util';

import type { MfaPolicy } from '../contracts/mfa.js';

/** `authn.mfa.policy.service` (schema default DefaultMfaPolicy), resolved by `@AutoinjectNamedService` and `resolveNamedService`. */
export const MFA_POLICY_SERVICE: INamedServiceOptions<MfaPolicy> = {
  default: 'DefaultMfaPolicy',
  is: (p) => isPlainObject(p) && typeof p.required === 'function' && typeof p.steps === 'function',
};
