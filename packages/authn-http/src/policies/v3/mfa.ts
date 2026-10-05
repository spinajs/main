import { Autoinject, Container, isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { MfaPolicy } from '@spinajs/authn/contracts';

import { refused } from './errors.js';
import { authenticatedPrincipal } from './principal.js';

/** The policy DefaultAuthnService asks at login: the registration named authn.mfa.policy.service (default DefaultMfaPolicy) nearest to `container`. */
async function mfaPolicyOf(container: IContainer, configured: unknown): Promise<MfaPolicy> {
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
