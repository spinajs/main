import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { resolveNamedService } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { MFA_POLICY_SERVICE, mfaEnrolmentRefusal } from '@spinajs/authn';
import { MfaPolicy } from '@spinajs/authn/contracts';

import { refused, unauthenticated } from './errors.js';
import { authenticatedPrincipal } from './principal.js';

/**
 * The policy DefaultAuthnService asks at login: the MfaPolicy authn.mfa.policy.service names in `container`'s
 * configuration. Resolved per call rather than injected, so the routes follow a configuration that changes after boot.
 */
export function mfaPolicyOf(container: IContainer): Promise<MfaPolicy> {
  return resolveNamedService(container, 'authn.mfa.policy.service', MfaPolicy, MFA_POLICY_SERVICE);
}

/**
 * Passes when MfaPolicy requires no step for the principal, or its authn.assurance is aal2 (A20, D2). An identity the
 * policy refuses over its stored enrolments (a step authn.mfa.steps does not list, or a listed step that does not see
 * the enrolment) gets mfa_required too; any other policy error fails the request.
 */
export class MfaSatisfied extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const principal = authenticatedPrincipal(req);
    const authn = principal.authn;
    if (authn?.assurance === 'aal2') return;
    if (!authn) throw refused('mfa_required', 'this route needs a second factor');
    const policy = await mfaPolicyOf(this.Container);
    let steps: readonly string[];
    try {
      steps = await policy.required({ type: principal.type, id: principal.id }, { method: authn.method, strategy: authn.strategy });
    } catch (err) {
      if (mfaEnrolmentRefusal(err)) throw refused('mfa_required', 'this route needs a second factor');
      throw err;
    }
    if (steps.length > 0) throw refused('mfa_required', 'this route needs a second factor');
  }
}

/**
 * For the MFA enrolment routes, in a policy group of its own beside the one with `Authenticated` (groups are ORed):
 * passes a pending session whose identity is enrolled in none of the steps of authn.mfa.steps and that the MFA policy does
 * not refuse. Such a session comes from a forced enrolment (authn.mfa.policy.force or forceForRoles), where enrolling is
 * the one way out of it (A09), or from the 2.x session upgrade, which stores no steps. A pending session of an enrolled
 * identity must complete its step instead.
 */
export class PendingMfaEnrolment extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a session');
    if (session.handle.state !== 'pending') throw refused('enrolment_closed', 'only a pending session forced to enrol passes here');
    const policy = await mfaPolicyOf(this.Container);
    const steps = [...(await policy.steps()).values()];
    if (steps.length === 0) throw refused('enrolment_closed', 'no MFA step is configured');
    for (const step of steps) {
      if (await step.enrolled(session.identity)) throw refused('enrolment_closed', 'complete the second factor instead');
    }
    // A stored enrolment no listed step sees must not be bypassed by enrolling a fresh factor.
    try {
      await policy.required(session.identity, { method: session.facts.method, strategy: session.facts.strategy });
    } catch (err) {
      if (mfaEnrolmentRefusal(err)) throw refused('enrolment_closed', 'enrolment is closed for this account');
      throw err;
    }
  }
}
