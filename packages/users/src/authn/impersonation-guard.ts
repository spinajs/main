import { GLOBAL } from '@spinajs/authz';
import { ImpersonationGuard, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import { UserIsBanned, UserNotActive } from '../exceptions.js';
import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
import { ACCESS_DOMAIN_KEY, AuthzTargetGuard, DEFAULT_IMPERSONATION_PERMISSION, IMPERSONATION_PERMISSION_KEY, accessDomain, actingFacts, signedInInteractively } from './target-guard.js';

type Answer = Awaited<ReturnType<ImpersonationGuard['allowed']>>;

const FORBIDDEN: Answer = Object.freeze({ ok: false, code: 'forbidden' });

export interface AuthzImpersonationGuardOptions {
  /** Default: the PrincipalFactory DI resolves (users' UserPrincipalFactory). */
  readonly principals?: PrincipalFactory;
  readonly targets?: AuthzTargetGuard;
}

/**
 * authn's ImpersonationGuard over authz (D26, B26, H18, H26). `forbidden` when the actor is not a user signed in
 * interactively through authn, is already impersonating, names itself, lacks `authz.impersonation.permission` at GLOBAL
 * in the access domain, or when the target is not a user that can act (unknown, deleted, inactive, banned); then
 * {@link AuthzTargetGuard} over the target as the impersonation session will carry it.
 */
@Injectable(ImpersonationGuard)
export class AuthzImpersonationGuard extends ImpersonationGuard {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  @Config(IMPERSONATION_PERMISSION_KEY, { defaultValue: DEFAULT_IMPERSONATION_PERMISSION })
  protected Permission: string;

  constructor(private readonly opts: AuthzImpersonationGuardOptions = {}) {
    super();
  }

  public async allowed(actor: Principal, target: IdentityRef): Promise<Answer> {
    const facts = actor.authn;
    if (actor.type !== 'user' || actor.authenticated !== true || !signedInInteractively(facts) || facts.impersonator || target.type !== 'user' || target.id === actor.id) {
      return FORBIDDEN;
    }

    const authz = await (await accessDomain(this.AccessDomain)).service();
    if (!(await authz.can(actor, this.Permission, GLOBAL))) {
      return FORBIDDEN;
    }

    const principal = await this.sessionPrincipal(actor, facts, target);
    // The store may match ids in another case than the request named them.
    if (!principal || principal.type !== 'user' || principal.id === actor.id) {
      return FORBIDDEN;
    }

    return (this.opts.targets ?? new AuthzTargetGuard()).check(actor, principal);
  }

  /** The target with the actor's authn facts and the actor as impersonator, no ceiling: what the session will carry (E1). */
  protected async sessionPrincipal(actor: Principal, facts: AuthnFacts, target: IdentityRef): Promise<Principal | null> {
    const sessionFacts: AuthnFacts = { ...actingFacts(facts), impersonator: { type: actor.type, id: actor.id } };

    try {
      return await (await this.principals()).principalOf(target, sessionFacts, {});
    } catch (err) {
      if (err instanceof ResourceNotFound || err instanceof UserNotActive || err instanceof UserIsBanned) {
        return null;
      }
      throw err;
    }
  }

  private async principals(): Promise<PrincipalFactory> {
    return this.opts.principals ?? ((await DI.resolve(PrincipalFactory)) as PrincipalFactory);
  }
}
