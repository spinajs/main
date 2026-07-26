import { Injectable } from '@spinajs/di';
import { BasePolicy, IController, IRoute, Request } from '@spinajs/http';

/**
 * A policy that permits everything. Used as the explicit default for the
 * liveness / readiness endpoints, which must be reachable by kubelet probes and
 * load balancers that cannot carry a token.
 *
 * This exists so the config can name a real class. Leaving the policy config
 * key empty would work, but the http layer logs `No policy named ... is
 * registered` on every boot for an unresolvable value, which reads like a
 * misconfiguration.
 */
@Injectable(BasePolicy)
export class PublicPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public execute(_req: Request): Promise<void> {
    return Promise.resolve();
  }
}
