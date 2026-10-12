import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { MfaStep } from '../contracts/mfa.js';
import { instantiate, kindOf, nearestRegistration, q } from '../registry/named.js';
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



// TODO: MFA registry should be accesible thru DI not some proxy class that holds list of it !

/**
 * The MFA steps of `authn.mfa.steps`, in list order, looked up by service name among the MfaStep registrations of the
 * container lineage (nearest first). Boot fails on an unknown service and an entry name that differs from the step's own `name`;
 * the schema refuses a duplicate name and the reserved name `recovery`. One per container.
 */
@PerChildInstance()
@Inject(Container)
export class MfaStepRegistry extends AsyncService {
  @Config('authn.mfa.steps')
  protected Entries: NamedEntry[];

  private listed: readonly MfaStep[] | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    const listed: MfaStep[] = [];
    for (const e of this.Entries) {
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
