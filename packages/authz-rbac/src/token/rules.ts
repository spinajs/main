import { AuthzConfigError } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import type { Configuration } from '@spinajs/configuration';
import { ResolveType, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

import { OwnRolesTokenRolePolicy, TokenRolePolicy } from './policy.js';

export const DEFAULT_TOKEN_ROLE_POLICY = 'OwnRolesTokenRolePolicy';

const EXCLUDED_KEY = 'authz.token.excludedRoles';
const POLICY_KEY = 'authz.token.rolePolicy';
const SERVICE_KEY = 'authz.token.rolePolicy.service';

/**
 * Whether `role` matches an entry of `patterns` (2.x `_role_excluded`): an exact role name, or a
 * name ending in `.*` that matches that prefix with its dot, so `route.*` covers `route.home` and
 * `route.admin.users` but neither `routes.read` nor `route`. It reads the assigned role's name only,
 * as `ceiling.roles` does: a role that extends an excluded role keeps the grants it inherits.
 */
export function roleExcluded(role: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith('.*') ? role.startsWith(pattern.slice(0, -1)) : role === pattern));
}

/** Whether `p` authenticated with a token. An `authn` that cannot be read counts as a token: narrowing never widens. */
export function isTokenPrincipal(p: Principal | undefined): boolean {
  if (p === undefined || p === null) return false;
  try {
    const authn: unknown = p.authn;
    if (authn === undefined || authn === null) return false;
    if (typeof authn !== 'object') return true;
    return (authn as { method?: unknown }).method === 'token';
  } catch {
    return true;
  }
}

/** The `authz.token` role rules (design §8.2, §18.3(g), B24, B07), built by {@link loadTokenRoleRules}. */
export class TokenRoleRules {
  readonly excludedRoles: readonly string[];

  constructor(excludedRoles: readonly string[], readonly policy: TokenRolePolicy) {
    this.excludedRoles = Object.freeze([...excludedRoles]);
    Object.freeze(this);
  }

  excluded(role: string): boolean {
    return roleExcluded(role, this.excludedRoles);
  }

  /**
   * The policy's answer for `roles` without the excluded ones, cut to those roles: unique, in input order, never wider.
   * @throws Error when the policy throws or answers anything but an array (the engine makes it model_error)
   */
  allowedRoles(owner: Principal, roles: readonly string[], profile?: string): string[] {
    const given = [...new Set(roles)].filter((r) => !this.excluded(r));
    const answer: unknown = this.policy.allowedRoles(owner, Object.freeze([...given]), profile);
    if (!Array.isArray(answer)) throw new Error(`rbac: ${this.policy.constructor.name}.allowedRoles must answer an array of role names at once (TokenRolePolicy)`);
    const allowed = new Set<unknown>(answer);
    return given.filter((r) => allowed.has(r));
  }

  allowedProfiles(owner: Principal): readonly string[] | Promise<readonly string[]> {
    return this.policy.allowedProfiles(owner);
  }

  /** Nothing to narrow: no excluded roles and exactly the default policy. */
  get trivial(): boolean {
    return this.excludedRoles.length === 0 && this.policy.constructor === OwnRolesTokenRolePolicy;
  }
}

/**
 * Reads `authz.token.excludedRoles` and `authz.token.rolePolicy.service`, and resolves the policy
 * from `container`: the TokenRolePolicy registration whose class name is the service name.
 * @throws (rejects) AuthzConfigError naming the key for a malformed value or an unknown service
 */
export async function loadTokenRoleRules(configuration: Pick<Configuration, 'get'>, container: IContainer): Promise<TokenRoleRules> {
  const excluded = excludedRoles(configuration.get<unknown>(['authz', 'token', 'excludedRoles'], undefined));
  const service = serviceName(configuration.get<unknown>(['authz', 'token', 'rolePolicy'], undefined));
  return new TokenRoleRules(excluded, await resolvePolicy(container, service));
}

function excludedRoles(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AuthzConfigError(`${EXCLUDED_KEY} must be an array of role names or 'prefix.*' patterns`);
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry === '') throw new AuthzConfigError(`${EXCLUDED_KEY} must hold non-empty strings; got ${JSON.stringify(entry)}`);
    // Only a trailing '.*' after a non-empty prefix: a full glob in a security list is refused on purpose.
    if (entry.includes('*') && !/^[^*]+\.\*$/.test(entry)) throw new AuthzConfigError(`${EXCLUDED_KEY}: ${JSON.stringify(entry)} is not a role name or a 'prefix.*' pattern`);
  }
  return value as string[];
}

function serviceName(value: unknown): string {
  if (value === undefined) return DEFAULT_TOKEN_ROLE_POLICY;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AuthzConfigError(`${POLICY_KEY} must be an object such as { service: '${DEFAULT_TOKEN_ROLE_POLICY}' }`);
  const service = (value as { service?: unknown }).service;
  if (service === undefined) return DEFAULT_TOKEN_ROLE_POLICY;
  if (typeof service !== 'string' || service === '') throw new AuthzConfigError(`${SERVICE_KEY} must be a non-empty class name`);
  return service;
}

async function resolvePolicy(container: IContainer, service: string): Promise<TokenRolePolicy> {
  const entry = container.Registry.getTypesChain(TokenRolePolicy)
    .filter((e) => !isFactory(e.type) && typeof e.type === 'function' && e.type.name === service)
    .pop();
  if (!entry) {
    // A DI registry reset in a test drops the decorator's registration of the default.
    if (service === DEFAULT_TOKEN_ROLE_POLICY) return new OwnRolesTokenRolePolicy();
    throw new AuthzConfigError(`${SERVICE_KEY} names ${JSON.stringify(service)}, but no TokenRolePolicy class of that name is registered; is the package that provides it loaded?`);
  }
  const type = entry.type as Class<TokenRolePolicy>;
  const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
  const policy: unknown = await at.resolve(type);
  if (!(policy instanceof TokenRolePolicy)) throw new AuthzConfigError(`${SERVICE_KEY}: ${JSON.stringify(service)} is not a TokenRolePolicy`);
  return policy;
}
