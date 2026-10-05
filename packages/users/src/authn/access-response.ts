import type { AccessSummary } from '@spinajs/authz';
import { AuthnResponseExtension } from '@spinajs/authn/contracts';
import type { Principal } from '@spinajs/authn/contracts';
import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import type { ModelDataWithRelationData } from '@spinajs/orm';

import type { User } from '../models/User.js';
import { DEFAULT_ACCESS_DOMAIN } from './access-schema.js';
import { ACCESS_DOMAIN_KEY, accessDomain } from './target-guard.js';

type ResponseKind = Parameters<AuthnResponseExtension['extend']>[0];

export type UserWithAccess = Omit<ModelDataWithRelationData<User>, 'Role'> & { readonly Access: AccessSummary };

/**
 * Adds `Access` to the login, MFA, role switch, impersonation and whoami answers (B25): the principal's `AccessSummary`
 * in the domain `authz.http.access.domain`, what `GET /user/access` answers. A failing summary rejects: an answer
 * without `Access` would hide the failure.
 */
@Injectable(AuthnResponseExtension)
export class AccessResponseExtension extends AuthnResponseExtension {
  @Config(ACCESS_DOMAIN_KEY, { defaultValue: DEFAULT_ACCESS_DOMAIN })
  protected AccessDomain: string;

  public async extend(_kind: ResponseKind, principal: Principal, body: Record<string, unknown>): Promise<void> {
    body.Access = await (await (await accessDomain(this.AccessDomain)).service()).summary(principal);
  }
}

/**
 * The 2.x login payload without `Role`, `ActiveRole` and `Grants`: the dehydrated user plus `Access`.
 * @throws InvalidArgument when `principal` is not `user:<user.Uuid>`
 */
export async function buildUserWithAccess(user: User, principal: Principal): Promise<UserWithAccess> {
  if (principal.type !== 'user' || principal.id !== user.Uuid) {
    throw new InvalidArgument(`buildUserWithAccess: the principal ${principal.type}:${principal.id} is not the user ${user.Uuid}`);
  }

  const body: Record<string, unknown> = { ...user.dehydrateWithRelations({ dateTimeFormat: 'iso' }) };
  await new AccessResponseExtension().extend('whoami', principal, body);
  return body as UserWithAccess;
}
