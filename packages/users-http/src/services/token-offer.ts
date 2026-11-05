import { AuthzConfigError, AuthzDomains, isPermissionGlob, matchesPermission } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PrincipalFactory, RoleSource, TokenService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { loadTokenRoleRules } from '@spinajs/authz-rbac';
import type { TokenRoleRules } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

// authn-token's TokenProfilePolicy, found by the name it registers under: importing authn-token would register its
// TokenService and strategies in every app that loads users-http.
const PROFILE_POLICY = 'TokenProfilePolicy';

interface ProfilePolicy {
  allowedProfiles(owner: IdentityRef): unknown;
}

/** 404, as authn-http's token routes answer, while no TokenService is registered: no token can be created. */
export function assertTokenRoutesOn(): void {
  if (!DI.RootContainer.hasImplementation(TokenService)) {
    throw Object.assign(new ResourceNotFound('the token routes are off: no TokenService is registered'), { error: 'not_found' });
  }
}

/**
 * The profiles authn-token's `TokenService.create` accepts for `owner`: its TokenProfilePolicy, none without one.
 * authz-rbac's `TokenRolePolicy.allowedProfiles` is not asked: no create or check path reads it.
 * @throws Error when the policy answers anything but a list of role names
 */
export async function offeredTokenProfiles(owner: IdentityRef): Promise<string[]> {
  if (!DI.RootContainer.hasImplementation(PROFILE_POLICY)) return [];
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
  if (!DI.RootContainer.hasImplementation(RoleSource)) return [];

  const source = (await DI.resolve(RoleSource)) as RoleSource;
  if (typeof source?.rolesOf !== 'function') throw new Error('users-http: the registered RoleSource has no rolesOf()');
  // The principal authn-token's create asks about: the owner alone, without sign-in facts or a ceiling.
  const bare = { type: owner.type, id: owner.id, authenticated: true, source: 'token', attributes: {} } as Parameters<RoleSource['rolesOf']>[0];
  const held = (await source.rolesOf(bare)).map((r) => r?.role).filter((r): r is string => typeof r === 'string' && r !== '');

  return (await tokenRoleRulesOf(accessDomain)).allowedRoles(owner, held, profile);
}

/** Permission globs left out of the offer, such as grants that only drive a client's menu. */
export const HIDDEN_TOKEN_PERMISSIONS_KEY = 'users.http.tokens.hiddenPermissions';

/**
 * The permissions a token of `owner` carrying {@link offeredTokenRoles} (for `profile` when given) is allowed at
 * GLOBAL: the names `scope.permissions` of `POST /user/tokens` narrows such a token to. The access domain's summary of
 * the principal TokenStrategy would build for it (token authn facts, the roles as ceiling, the profile as attribute),
 * so the token role rules and whatever the application derives from the profile apply. Less the globs in
 * {@link HIDDEN_TOKEN_PERMISSIONS_KEY}. None when no role is offered.
 * @throws when the roles cannot be offered, the hidden globs are not a list of permission globs, or the summary fails
 */
export async function offeredTokenPermissions(owner: Principal, accessDomain: string, profile?: string): Promise<string[]> {
  const roles = await offeredTokenRoles(owner, accessDomain, profile);
  if (roles.length === 0) return [];
  const hidden = await hiddenTokenPermissions();

  const factory = await DI.resolve(PrincipalFactory);
  const asToken = await factory.principalOf(
    { type: owner.type, id: owner.id },
    { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt: new Date() },
    { ceiling: { roles }, ...(profile !== undefined ? { attributes: { profile } } : {}) },
  );
  const domains = DI.get(AuthzDomains);
  if (!domains) throw new AuthzConfigError('users-http: no AuthzDomains to ask for the token permissions');
  const summary = await (await domains.service(accessDomain)).summary(asToken);

  const names = new Set(summary.permissions.map((p) => p.name));
  return [...names].filter((name) => !hidden.some((glob) => matchesPermission(glob, name))).sort();
}

async function hiddenTokenPermissions(): Promise<readonly string[]> {
  const configuration = await DI.resolve(Configuration);
  const globs: unknown = configuration.get(HIDDEN_TOKEN_PERMISSIONS_KEY, []);
  if (!Array.isArray(globs) || !globs.every((g) => isPermissionGlob(g))) {
    throw new AuthzConfigError(`users-http: ${HIDDEN_TOKEN_PERMISSIONS_KEY} must be a list of permission globs`);
  }
  return globs;
}

/** As authz-rbac's token role extension loads them for the RBAC model of domain `name`. */
async function tokenRoleRulesOf(name: string): Promise<TokenRoleRules> {
  const domains = DI.get(AuthzDomains);
  const container: IContainer | undefined = domains?.names().includes(name) ? domains.container(name) : name === 'root' ? DI.RootContainer : undefined;
  if (!container) throw new AuthzConfigError(`users-http: the access domain ${JSON.stringify(name)} is not a live authz domain`);
  if (!container.hasRegistered(Configuration)) throw new AuthzConfigError(`users-http: the access domain ${JSON.stringify(name)} has no Configuration to read authz.token from`);
  return loadTokenRoleRules((await container.resolve(Configuration)) as Configuration, container);
}
