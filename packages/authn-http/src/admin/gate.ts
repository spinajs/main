import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { CredentialAdminGuard, SessionIssuer } from '@spinajs/authn/contracts';
import type { TotpService } from '@spinajs/authn-totp/service';

import { totpServiceOf } from '../mfa/gate.js';
import { notFound } from '../policies/v3/errors.js';
import { serviceRegistered } from '../policies/v3/groups.js';

// Not exported by the package barrel; nothing here registers at import.

/**
 * The first policy of the credential admin controller: 404 `not_found` while no CredentialAdminGuard is registered.
 * Without a guard nobody can tell who may administer whom, so the group is off (design §22.11, RFC N8b-1).
 */
export class CredentialAdminGuardRegistered extends serviceRegistered(CredentialAdminGuard, 'the credential admin routes are off') {}

/** 404 `not_found` while no SessionIssuer is registered: the admin sessions revoke is off. */
export class SessionIssuerRegistered extends serviceRegistered(SessionIssuer, 'the admin sessions route is off') {}

/** authn-totp's TotpService while the MFA enrolment routes are on (`totpServiceOf`); else 404 `not_found` naming this route. */
export async function adminTotpServiceOf(container: IContainer, encryptionKey: string | null | undefined, policyService: string): Promise<TotpService> {
  try {
    return await totpServiceOf(container, encryptionKey, policyService);
  } catch (err) {
    if (err instanceof ResourceNotFound) throw notFound('not_found', 'the admin MFA reset route is off');
    throw err;
  }
}

/** 404 `not_found` unless TOTP is on as for the enrolment routes: an MFA that login never asks for has nothing to reset. */
export class AdminMfaResetOn extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.encryptionKey.secret')
  protected MfaEncryptionKey: string | null | undefined;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    await adminTotpServiceOf(this.Container, this.MfaEncryptionKey, this.MfaPolicyService);
  }
}
