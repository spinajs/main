import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import { CredentialAdminGuard } from '@spinajs/authn/contracts';
import type { CredentialAdminAction, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import { CREDENTIAL_ADMIN_PERMISSION_KEY } from './credential-admin-schema.js';
import { ACCESS_DOMAIN_KEY, AuthzTargetGuard, accessDomain, signedInInteractively } from './target-guard.js';

type Answer = Awaited<ReturnType<CredentialAdminGuard['allowed']>>;

const FORBIDDEN: Answer = Object.freeze({ ok: false, code: 'forbidden' });
const NOT_FOUND: Answer = Object.freeze({ ok: false, code: 'not_found' });

export interface AuthzCredentialAdminGuardOptions {
  readonly targets?: AuthzTargetGuard;
}

/**
 * authn's CredentialAdminGuard over authz (A25, SR-10, B26). `forbidden` when the actor is not a user signed in
 * interactively through authn, is impersonating, names itself (the owner routes change one's own credentials), or lacks
 * `authz.credentials.permission` at GLOBAL in the access domain, or when the target is not a user; then
 * {@link AuthzTargetGuard.checkIdentity}: `protected_role`, `escalation`, and `not_found` for an unknown or deleted
 * target. Any other error rejects. Every action gets the same answer; an app that narrows per action registers its own
 * guard.
 */
@Injectable(CredentialAdminGuard)
export class AuthzCredentialAdminGuard extends CredentialAdminGuard {
  @Config(ACCESS_DOMAIN_KEY)
  protected AccessDomain: string;

  @Config(CREDENTIAL_ADMIN_PERMISSION_KEY)
  protected Permission: string;

  constructor(private readonly opts: AuthzCredentialAdminGuardOptions = {}) {
    super();
  }

  public async allowed(actor: Principal, target: IdentityRef, _action: CredentialAdminAction): Promise<Answer> {
    const facts = actor.authn;
    if (actor.type !== 'user' || actor.authenticated !== true || !signedInInteractively(facts) || facts.impersonator || target.type !== 'user' || target.id === actor.id) {
      return FORBIDDEN;
    }

    const permission: unknown = this.Permission;
    // A value set past the schema must not reach authz as a permission name it was never meant to be.
    if (typeof permission !== 'string' || permission.length === 0) {
      throw new AuthzConfigError(`users: ${CREDENTIAL_ADMIN_PERMISSION_KEY} must be a permission name`);
    }

    const authz = await (await accessDomain(this.AccessDomain)).service();
    if (!(await authz.can(actor, permission, GLOBAL))) {
      return FORBIDDEN;
    }

    try {
      return await (this.opts.targets ?? new AuthzTargetGuard()).checkIdentity(actor, target);
    } catch (err) {
      if (err instanceof ResourceNotFound) {
        return NOT_FOUND;
      }
      throw err;
    }
  }
}
