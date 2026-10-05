import { AuthzService, SYSTEM } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, Ceiling, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { DI, Injectable } from '@spinajs/di';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';

import { UserIsBanned, UserNotActive } from '../exceptions.js';
import { UserBase } from '../models/User.js';
import type { User } from '../models/User.js';
import { userModel } from '../model-token.js';
import { PrincipalAttributeProvider } from './attribute-provider.js';

type Extra = Parameters<PrincipalFactory['principalOf']>[2];

/** What the record path takes: the principal of a user record the caller already holds. */
export interface UserPrincipalOptions {
  readonly ceiling?: Ceiling;
}

/** The `source` of a principal built from a user record rather than from an authentication. */
export const IDENTITY_PRINCIPAL_SOURCE = 'identity';

/**
 * Builds `user:<Uuid>` principals (D4), for authn (`principalOf(identity, facts, extra)`) and for code that
 * holds a user record: apps, CLI commands, jobs (`principalOf(user, opts)`). The principal carries the record
 * as `identity` and the attributes of every {@link PrincipalAttributeProvider} over the strategy's.
 *
 * A user that is unknown, soft deleted, inactive or banned is refused: authn checks the account's status
 * before it asks for a principal, so getting here with such a user is an error, not a failed login. Except
 * {@link rightsPrincipalOf}, which accepts an inactive or banned account: it judges an account's rights and must
 * never start a session.
 */
@Injectable(PrincipalFactory)
export class UserPrincipalFactory extends PrincipalFactory {
  /** authn's side: loads the user by Uuid through the application's user model. `source` is 'session' with a session handle, else 'token'. */
  public principalOf(id: IdentityRef, facts: AuthnFacts, extra: Extra): Promise<Principal>;
  /**
   * For a user record in hand; `source` is {@link IDENTITY_PRINCIPAL_SOURCE} and there are no authn facts.
   * A record without populated `Metadata` is read again (by Uuid, as SYSTEM), so its ban is never missed;
   * the principal's `identity` is then the record read, not the one passed.
   */
  public principalOf(user: User, opts?: UserPrincipalOptions): Promise<Principal>;
  public async principalOf(subject: IdentityRef | User, factsOrOpts?: AuthnFacts | UserPrincipalOptions, extra?: Extra): Promise<Principal> {
    if (subject instanceof UserBase) {
      const opts = (factsOrOpts ?? {}) as UserPrincipalOptions;
      // A ban lives in the metadata; a record read without it would pass as not banned.
      const user = subject.Metadata?.Populated === true || subject.DeletedAt ? subject : await this.load({ type: 'user', id: subject.Uuid });
      return this.build(user, { source: IDENTITY_PRINCIPAL_SOURCE, ...(opts.ceiling ? { ceiling: opts.ceiling } : {}) }, undefined);
    }

    const facts = factsOrOpts as AuthnFacts;
    const e: Extra = extra ?? {};
    const user = await this.load(subject);

    return this.build(
      user,
      {
        source: facts.sessionHandle ? 'session' : 'token',
        authn: facts,
        ...(e.ceiling ? { ceiling: e.ceiling } : {}),
        ...(e.onBehalfOf ? { onBehalfOf: e.onBehalfOf } : {}),
        ...(e.delegation ? { delegation: e.delegation } : {}),
      },
      e.attributes,
    );
  }

  /**
   * The principal user `id` would carry signed in with `facts` (none: as for a record in hand), whatever the state of
   * its account: for judging the rights of an account another user acts on (A25), where an inactive or banned account
   * still holds its roles.
   * @throws ResourceNotFound for an unknown or soft-deleted user
   */
  public async rightsPrincipalOf(id: IdentityRef, facts?: AuthnFacts): Promise<Principal> {
    const user = await this.load(id);
    if (user.DeletedAt) {
      throw new ResourceNotFound(`No user ${user.Uuid}`);
    }

    const base = facts ? { source: facts.sessionHandle ? 'session' : 'token', authn: facts } : { source: IDENTITY_PRINCIPAL_SOURCE };
    return this.build(user, base, undefined, false);
  }

  protected async load(id: IdentityRef): Promise<User> {
    if (id?.type !== 'user') {
      throw new InvalidArgument(`UserPrincipalFactory builds user principals only, not ${JSON.stringify(id?.type)}`, 'id');
    }

    // The application's user model may be an @AccessResource: the lookup itself must not be scoped.
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const user = await authz.runAs(SYSTEM, 'principal-factory', () => userModel().query().whereUuid(id.id).populate('Metadata').first());

    if (!user) {
      throw new ResourceNotFound(`No user ${id.id}`);
    }

    return user as User;
  }

  protected async build(user: User, base: Omit<Principal, 'type' | 'id' | 'authenticated' | 'attributes' | 'identity'>, asserted: Readonly<Record<string, unknown>> | undefined, refuseUnusable = true): Promise<Principal> {
    if (refuseUnusable) {
      assertUsable(user);
    }

    const attributes: Record<string, unknown> = { ...(asserted ?? {}) };
    const principal = (): Principal => ({ type: 'user', id: user.Uuid, authenticated: true, ...base, attributes: Object.freeze({ ...attributes }), identity: user });

    for (const provider of await providers()) {
      Object.assign(attributes, await provider.attributes(user, principal()));
    }

    return principal();
  }
}

function assertUsable(user: User): void {
  if (user.DeletedAt) {
    throw new ResourceNotFound(`No user ${user.Uuid}`);
  }

  if (!user.IsActive) {
    throw new UserNotActive(`User ${user.Uuid} is not active`, { user: user.Uuid });
  }

  if (user.IsBanned) {
    throw new UserIsBanned(`User ${user.Uuid} is banned`, { user: user.Uuid });
  }
}

async function providers(): Promise<PrincipalAttributeProvider[]> {
  if (!DI.RootContainer.hasRegistered(PrincipalAttributeProvider)) {
    return [];
  }

  return (await DI.resolve(Array.ofType(PrincipalAttributeProvider))) as PrincipalAttributeProvider[];
}
