import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import type { TotpService } from '@spinajs/authn-totp/service';

import { notFound } from '../policies/v3/errors.js';

/**
 * The DI key of authn-totp's TotpService (`@Injectable()` registers a class under its name). authn-totp is never
 * imported at module load: it loads TotpMfaStep, which registers itself as an MfaStep, and scanning these routes must
 * not do that.
 */
export const TOTP_SERVICE = 'TotpService';

const off = () => notFound('not_found', 'the MFA enrolment routes are off');

/**
 * authn-totp's TotpService while login asks for TOTP: authn.mfa.steps lists authn-totp's TotpMfaStep and
 * authn.mfa.encryptionKey.secret is set (what authn-totp calls "Turning TOTP on"). Otherwise 404 `not_found`: a factor
 * enrolled here that login never asks for would only look like a second factor (design §22.11). `encryptionKey` is
 * that secret as the caller's `@Config` reads it from `container`'s configuration.
 */
export async function totpServiceOf(container: IContainer, encryptionKey: string | null | undefined): Promise<TotpService> {
  if (!container.hasRegistered(TOTP_SERVICE)) throw off();
  if (!encryptionKey) throw off();
  // Loaded here, not at module load: the @spinajs/authn root registers its services in every app that imports it.
  const { mfaSteps } = await import('@spinajs/authn');
  const steps = [...(await mfaSteps(container)).values()];
  // The name check first, so an app that lists no such step never loads authn-totp here.
  if (!steps.some((s) => s.constructor.name === 'TotpMfaStep')) throw off();
  // Already loaded where the real classes registered. DI keeps the first class of a name, so a foreign TotpService or
  // TotpMfaStep stays what resolves and fails the instanceof checks.
  const totp = await import('@spinajs/authn-totp/service');
  if (!steps.some((s) => s instanceof totp.TotpMfaStep)) throw off();
  const service = await container.resolve<unknown>(TOTP_SERVICE);
  if (!(service instanceof totp.TotpService)) throw off();
  return service;
}

/** The first policy of the MFA enrolment controller: 404 `not_found` unless `totpServiceOf` finds the service. */
export class TotpEnrolmentOn extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.encryptionKey.secret')
  protected MfaEncryptionKey: string | null | undefined;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    await totpServiceOf(this.Container, this.MfaEncryptionKey);
  }
}
