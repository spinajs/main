import type { IContainer } from '@spinajs/di';
import { resolveNamedServices } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { MfaStep } from '../contracts/mfa.js';
import { q } from '../support/format.js';

/** completeMfa's step name for recovery codes; no configured step may take it. */
export const RECOVERY_STEP = 'recovery';

/**
 * The steps of `authn.mfa.steps` for `container`, keyed by step name in list order: what
 * `@AutoinjectService('authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' })` injects, for code that reads the
 * list when it runs rather than when DI builds it. Fails on an unknown service (ServiceNotFound), an entry name that
 * differs from the step's own `name` and a service that is not an MfaStep (InvalidOption).
 */
export async function mfaSteps(container: IContainer): Promise<Map<string, MfaStep>> {
  const steps = await resolveNamedServices(container, 'authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' });
  // Duck-typed: steps built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
  for (const [name, step] of steps) {
    if (typeof step.verify !== 'function' || typeof step.enrolled !== 'function') {
      throw new InvalidOption(`authn.mfa.steps entry ${q(name)}: the service is not an MfaStep`);
    }
  }
  return steps;
}
