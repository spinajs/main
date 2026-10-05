import type { IContainer } from '@spinajs/di';
import type { IController, IRoute, Request } from '@spinajs/http';

import { FreshAuth, MfaSatisfied } from '../../src/v3/index.js';

/** The probe controller's base path (support/AuthnPolicyProbeController). */
export const POLICY_PROBE_PATH = 'authn-policy-probe';

// Routes resolve their policies from the root container; the policy suite keeps its services in a child container.
let suiteContainer: IContainer | null = null;

export function usePolicyContainer(container: IContainer | null): void {
  suiteContainer = container;
}

export class SuiteFreshAuth extends FreshAuth {
  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    if (suiteContainer) this.Container = suiteContainer;
    return super.execute(req, action, instance);
  }
}

export class SuiteMfaSatisfied extends MfaSatisfied {
  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    if (suiteContainer) this.Container = suiteContainer;
    return super.execute(req, action, instance);
  }
}
