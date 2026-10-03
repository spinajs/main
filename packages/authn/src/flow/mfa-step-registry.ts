import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { MfaStep } from '../contracts/mfa.js';
import { instantiate, kindOf, nearestRegistration, q, readNamedEntries } from '../registry/named.js';
import type { NamedEntry } from '../registry/named.js';

/** completeMfa's step name for recovery codes; no configured step may take it. */
export const RECOVERY_STEP = 'recovery';

// Duck-typed: steps built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
function check(e: NamedEntry, s: unknown): MfaStep {
  const at = `authn.mfa.steps entry ${q(e.name)} (service ${q(e.service)})`;
  const step = s as MfaStep | null;
  if (step === null || typeof step !== 'object' || typeof step.verify !== 'function' || typeof step.enrolled !== 'function') {
    throw new InvalidOption(`${at}: the service is not an MfaStep`);
  }
  if (step.name !== e.name) {
    const own = typeof step.name === 'string' ? q(step.name) : `a ${kindOf(step.name)}`;
    throw new InvalidOption(`${at}: the step names itself ${own}; the entry name must match it`);
  }
  return step;
}

/**
 * The MFA steps of `authn.mfa.steps`, in list order, looked up by service name among the MfaStep registrations of the
 * container lineage (nearest first). Boot fails on an unknown service, a duplicate name, the reserved name
 * `recovery`, and an entry name that differs from the step's own `name`. One per container.
 */
@PerChildInstance()
@Inject(Container)
export class MfaStepRegistry extends AsyncService {
  private listed: readonly MfaStep[] | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    if (this.listed) return;
    const configuration = (await this.container.resolve(Configuration)) as Configuration | null;
    if (configuration === null || typeof configuration !== 'object' || typeof configuration.get !== 'function') {
      throw new InvalidOperation('MfaStepRegistry: the resolved Configuration has no get()');
    }
    const entries = readNamedEntries(configuration.get('authn.mfa.steps'), 'authn.mfa.steps', 'step');
    const listed: MfaStep[] = [];
    for (const e of entries) {
      if (e.name === RECOVERY_STEP) throw new InvalidOption(`authn.mfa.steps: the step name ${q(RECOVERY_STEP)} is reserved for recovery codes`);
      const type = nearestRegistration(this.container, MfaStep, e.service);
      if (!type) throw new InvalidOption(`authn.mfa.steps entry ${q(e.name)}: no MfaStep is registered as service ${q(e.service)}`);
      listed.push(check(e, await instantiate(this.container, type)));
    }
    this.listed = Object.freeze(listed);
    await super.resolve();
  }

  /** In list order. */
  public steps(): readonly MfaStep[] {
    if (!this.listed) throw new InvalidOperation('MfaStepRegistry is not resolved');
    return this.listed;
  }

  public get(name: string): MfaStep | undefined {
    return this.steps().find((s) => s.name === name);
  }
}
