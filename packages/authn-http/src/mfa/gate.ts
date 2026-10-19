import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { MfaEnrolmentService } from '@spinajs/authn/contracts';

import { notFound } from '../policies/v3/errors.js';

/**
 * True while `container` registers an MfaEnrolmentService and login asks for its step (authn-totp's TotpService:
 * authn.mfa.steps lists TotpMfaStep and authn.mfa.encryptionKey.secret is set). The routes stay off otherwise: a factor
 * enrolled there that login never asks for would only look like a second factor (design §22.11). `policyService` is
 * authn.mfa.policy.service.
 */
export async function mfaEnrolmentOn(container: IContainer, policyService: string): Promise<boolean> {
  // Asked per call, as the other route gates do: DI keeps a policy instance across server rebuilds.
  if (!container.hasRegistered(MfaEnrolmentService as unknown as Class<MfaEnrolmentService>)) return false;
  const enrolment = await container.resolve(MfaEnrolmentService as unknown as Class<MfaEnrolmentService>);
  // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
  const { mfaPolicyOf } = await import('../policies/v3/mfa.js');
  return enrolment.enabled((await (await mfaPolicyOf(container, policyService)).steps()).values());
}

/** The first policy of the MFA enrolment controller: 404 `not_found` unless `mfaEnrolmentOn`. */
export class TotpEnrolmentOn extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!(await mfaEnrolmentOn(this.Container, this.MfaPolicyService))) throw notFound('not_found', 'the MFA enrolment routes are off');
  }
}
