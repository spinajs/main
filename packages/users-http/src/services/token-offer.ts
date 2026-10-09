import { AuthzConfigError, AuthzDomains } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { loadTokenRoleRules } from '@spinajs/authz-rbac';
import type { TokenRoleRules } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

// authn-token's TokenProfilePolicy, found by the name it registers under: importing authn-token would register its
// TokenService and strategies in every app that loads users-http.
const PROFILE_POLICY = 'TokenProfilePolicy';

interface ProfilePolicy {
  allowedProfiles(owner: IdentityRef): unknown;
}

/** Leaves out the bare abstract class a resolve of an unregistered type records under its own name. */
function implemented(token: Class<unknown> | string): boolean {
  return (DI.RootContainer.getRegisteredTypes(token) ?? []).some((t) => t !== token);
}

/** 404, as authn-http's token routes answer, while no TokenService is registered: no token can be created. */
export function assertTokenRoutesOn(): void {
  if (!implemented(TokenService as unknown as Class<TokenService>)) {
    throw Object.assign(new ResourceNotFound('the token routes are off: no TokenService is registered'), { error: 'not_found' });
  }
}

/**
 * The profiles authn-token's `TokenService.create` accepts for `owner`: its TokenProfilePolicy, none without one.
 * authz-rbac's `TokenRolePolicy.allowedProfiles` is not asked: no create or check path reads it.
 * @throws Error when the policy answers anything but a list of role names
 */
export async function offeredTokenProfiles(owner: IdentityRef): Promise<string[]> {
  if (!implemented(PROFILE_POLICY)) return [];
  const policy = (await DI.RootContainer.resolve<ProfilePolicy>(PROFILE_POLICY)) as ProfilePolicy;
  if (typeof policy?.allowedProfiles !== 'function') throw new Error(`users-http: the registered ${PROFILE_POLICY} has no allowedProfiles()`);
  const answer: unknown = await policy.allowedProfiles({ type: owner.type, id: owner.id });
  if (!Array.isArray(answer) || !answer.every((p) => typeof p === 'string' && p !== '')) {
    throw new Error(`users-http: ${PROFILE_POLICY}.allowedProfiles must answer a list of role names`);
  }
  return [...new Set(answer as string[])];
}

/**
 * The roles a token of `owner` may be created with and keeps at check time: those authn-token's create accepts (each
 * held by the owner at any scope, by the RoleSource) cut by `authz.token` of the access domain (excluded roles and
 * the TokenRolePolicy, for `profile` when given). None for a profile the create path refuses, or without a RoleSource.
 * @throws when the token role rules cannot be loaded or the policy fails
 */
export async function offeredTokenRoles(owner: Principal, accessDomain: string, profile?: string): Promise<string[]> {
  if (profile !== undefined && !(await offeredTokenProfiles(owner)).includes(profile)) return [];
  if (!implemented(RoleSource as unknown as Class<RoleSource>)) return [];

  const source = (await DI.resolve(RoleSource)) as RoleSource;
  if (typeof source?.rolesOf !== 'function') throw new Error('users-http: the registered RoleSource has no rolesOf()');
  // The principal authn-token's create asks about: the owner alone, without sign-in facts or a ceiling.
  const bare = { type: owner.type, id: owner.id, authenticated: true, source: 'token', attributes: {} } as Parameters<RoleSource['rolesOf']>[0];
  const held = (await source.rolesOf(bare)).map((r) => r?.role).filter((r): r is string => typeof r === 'string' && r !== '');

  return (await tokenRoleRulesOf(accessDomain)).allowedRoles(owner, held, profile);
}

/** As authz-rbac's token role extension loads them for the RBAC model of domain `name`. */
async function tokenRoleRulesOf(name: string): Promise<TokenRoleRules> {
  const domains = DI.get(AuthzDomains);
  const container: IContainer | undefined = domains?.names().includes(name) ? domains.container(name) : name === 'root' ? DI.RootContainer : undefined;
  if (!container) throw new AuthzConfigError(`users-http: the access domain ${JSON.stringify(name)} is not a live authz domain`);
  if (!container.hasRegistered(Configuration)) throw new AuthzConfigError(`users-http: the access domain ${JSON.stringify(name)} has no Configuration to read authz.token from`);
  return loadTokenRoleRules((await container.resolve(Configuration)) as Configuration, container);
}
