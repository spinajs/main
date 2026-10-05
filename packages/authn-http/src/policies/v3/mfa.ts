import { Autoinject, Container, isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { MfaPolicy } from '@spinajs/authn/contracts';

import { refused, unauthenticated } from './errors.js';
import { authenticatedPrincipal } from './principal.js';

/** The policy DefaultAuthnService asks at login: the registration named authn.mfa.policy.service (default DefaultMfaPolicy) nearest to `container`. */
export async function mfaPolicyOf(container: IContainer, configured: unknown): Promise<MfaPolicy> {
  const name = configured ?? 'DefaultMfaPolicy';
  const types = container.getRegisteredTypesChain(MfaPolicy as unknown as Class<MfaPolicy>) ?? [];
  const type = [...types].reverse().find((t) => t.name === name);
  if (!type) throw new InvalidOption(`authn.mfa.policy.service ${JSON.stringify(name)}: no MfaPolicy is registered under that name`);
  return (isFactory(type) ? await (type as Factory<unknown>)(container) : await container.resolve(type as Class<unknown>)) as MfaPolicy;
}

/** Passes when MfaPolicy requires no step for the principal, or its authn.assurance is aal2 (A20, D2). */
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
    const configuration = await this.Container.resolve(Configuration);
    const policy = await mfaPolicyOf(this.Container, configuration.get('authn.mfa.policy.service'));
    const steps = await policy.required({ type: principal.type, id: principal.id }, { method: authn.method, strategy: authn.strategy });
    if (steps.length > 0) throw refused('mfa_required', 'this route needs a second factor');
  }
}

/**
 * For the MFA enrolment routes, in a policy group of its own beside the one with `Authenticated` (groups are ORed):
 * passes a pending session whose identity is enrolled in none of the steps of authn.mfa.steps. Such a session exists only
 * when the MFA policy forces enrolment (authn.mfa.policy.force or forceForRoles), and enrolling is the one way out of it
 * (A09). A pending session of an enrolled identity must complete its step instead.
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
    // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
    const { MfaStepRegistry } = await import('@spinajs/authn');
    const steps = (await this.Container.resolve(MfaStepRegistry)).steps();
    if (steps.length === 0) throw refused('enrolment_closed', 'no MFA step is configured');
    for (const step of steps) {
      if (await step.enrolled(session.identity)) throw refused('enrolment_closed', 'complete the second factor instead');
    }
  }
}
