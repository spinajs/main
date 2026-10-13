import type { IContainer } from '@spinajs/di';
import { resolveNamedServices } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';

import { MfaStep } from '../contracts/mfa.js';
import { q } from '../support/format.js';

/** completeMfa's step name for recovery codes; no configured step may take it. */
export const RECOVERY_STEP = 'recovery';

/** The DI cache key a container keeps its steps under; `container.uncache(MFA_STEPS_KEY)` makes the next read list them again. */
export const MFA_STEPS_KEY = 'authn.mfa.steps';

async function listSteps(container: IContainer): Promise<ReadonlyMap<string, MfaStep>> {
  const steps = await resolveNamedServices(container, 'authn.mfa.steps', MfaStep, { lineage: true, keyBy: 'name' });
  // Duck-typed: steps built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
  for (const [name, step] of steps) {
    if (typeof step.verify !== 'function' || typeof step.enrolled !== 'function') {
      throw new InvalidOption(`authn.mfa.steps entry ${q(name)}: the service is not an MfaStep`);
    }
  }
  return steps;
}

/**
 * The steps of `authn.mfa.steps` for `container`, keyed by step name in list order, looked up by service name across
 * the container lineage (nearest first). Listed once per container, on the first read (the authn boot when a strategy
 * is interactive), so login, the MFA policy and the enrolment routes see one list: a later Configuration.set changes
 * nothing until MFA_STEPS_KEY is uncached. Fails on an unknown service (ServiceNotFound), an entry name that differs
 * from the step's own `name` and a service that is not an MfaStep (InvalidOption); a failed read is not kept.
 */
export function mfaSteps(container: IContainer): Promise<ReadonlyMap<string, MfaStep>> {
  if (container.Cache.has(MFA_STEPS_KEY)) return (container.Cache.get(MFA_STEPS_KEY) as Promise<ReadonlyMap<string, MfaStep>>[])[0];
  const listed = listSteps(container);
  container.Cache.add(MFA_STEPS_KEY, listed);
  listed.catch(() => container.uncache(MFA_STEPS_KEY));
  return listed;
}
