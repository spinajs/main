import { AuthzConfigError, AuthzDomains, AuthzService, GLOBAL } from '@spinajs/authz';
import type { EvaluationContext, Principal } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { RbacService } from '@spinajs/authz-rbac';
import type { RbacModel, RoleGraph } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

import { UserPrincipalFactory } from '../principal/user-principal-factory.js';

/** The permission an impersonator needs at GLOBAL (B26). */
export const IMPERSONATION_PERMISSION_KEY = 'authz.impersonation.permission';
export const DEFAULT_IMPERSONATION_PERMISSION = 'user:impersonate';

/** Roles whose holders nobody may impersonate or administer (B26, A25). */
export const PROTECTED_ROLES_KEY = 'authz.impersonation.protectedRoles';
export const DEFAULT_PROTECTED_ROLES: readonly string[] = Object.freeze(['admin']);

/** The authz domain whose rights the rule compares; authz-http's key, read here so users needs no authz-http. */
export const ACCESS_DOMAIN_KEY = 'authz.http.access.domain';

export type TargetRuleAnswer = { readonly ok: true } | { readonly ok: false; readonly code: 'protected_role' | 'escalation' };

export interface AccessDomain {
  readonly name: string;
  readonly container: IContainer;
  service(): Promise<AuthzService>;
}

export interface AuthzTargetGuardOptions {
  /** For checkIdentity; default: the PrincipalFactory DI resolves when it is users' own, else a new one. */
  readonly users?: UserPrincipalFactory;
}

export async function accessDomain(): Promise<AccessDomain> {
  const name = (await configuration()).get<unknown>(ACCESS_DOMAIN_KEY, 'root');
  if (typeof name !== 'string' || name === '') {
    throw new AuthzConfigError(`${ACCESS_DOMAIN_KEY} must be a domain name, got ${JSON.stringify(name)}`);
  }

  if (name === 'root') {
    return { name, container: DI.RootContainer, service: async () => (await DI.resolve(AuthzService)) as AuthzService };
  }

  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return { name, container: domains.container(name), service: () => domains.service(name) };
}

export async function impersonationPermission(): Promise<string> {
  const value = (await configuration()).get<unknown>(IMPERSONATION_PERMISSION_KEY, DEFAULT_IMPERSONATION_PERMISSION);
  if (typeof value !== 'string' || value === '') {
    throw new AuthzConfigError(`${IMPERSONATION_PERMISSION_KEY} must be a permission name, got ${JSON.stringify(value)}`);
  }
  return value;
}

export async function protectedRoles(): Promise<readonly string[]> {
  const value = (await configuration()).get<unknown>(PROTECTED_ROLES_KEY, DEFAULT_PROTECTED_ROLES);
  if (!Array.isArray(value) || !value.every((r) => typeof r === 'string' && r !== '')) {
    throw new AuthzConfigError(`${PROTECTED_ROLES_KEY} must be a list of role names, got ${JSON.stringify(value)}`);
  }
  return value as string[];
}

/** The authn facts of a principal the actor's session would carry for another account: the actor's sign-in, nothing it was granted. */
export function actingFacts(facts: AuthnFacts): AuthnFacts {
  return {
    method: facts.method,
    strategy: facts.strategy,
    assurance: facts.assurance,
    mfa: facts.mfa,
    authenticatedAt: facts.authenticatedAt,
    ...(facts.sessionHandle ? { sessionHandle: facts.sessionHandle } : {}),
  };
}

/**
 * The rule an actor passes to act on another account: impersonation (B26) and the credential admin routes (A25, SR-10).
 * `protected_role` when the target holds a protected role (at any scope, directly, through a subject set, or through a
 * role that reaches one by `extends`, a higher ladder rank or `implies`); `escalation` when the actor's combined GLOBAL
 * permission set in the access domain does not strictly contain the target's (`AuthzService.covers`, every model, ABAC
 * included).
 * @throws AuthzConfigError when the access domain has no RbacService of its own, or the config is malformed
 */
export class AuthzTargetGuard {
  constructor(private readonly opts: AuthzTargetGuardOptions = {}) {}

  /** `target` is the principal the actor would act as or on; build it the way the session that uses it will carry it. */
  public async check(actor: Principal, target: Principal): Promise<TargetRuleAnswer> {
    const domain = await accessDomain();
    const rbac = await registeredInDomain(domain, RbacService);
    const authz = await domain.service();

    const guarded = await protectedRoles();
    if (guarded.length > 0) {
      const held = await reachableRoles(rbac, domain.name, target);
      if (guarded.some((r) => held.has(r))) {
        return { ok: false, code: 'protected_role' };
      }
    }

    return (await authz.covers(actor, target, GLOBAL)) ? { ok: true } : { ok: false, code: 'escalation' };
  }

  /**
   * For the credential admin routes (A25): the target user judged on its rights, with the actor's sign-in facts, no
   * ceiling and no strategy attributes. An inactive or banned account still counts by its roles.
   * @throws ResourceNotFound for an unknown or soft-deleted user
   */
  public async checkIdentity(actor: Principal, target: IdentityRef): Promise<TargetRuleAnswer> {
    const principal = await (await this.users()).rightsPrincipalOf(target, actor.authn ? actingFacts(actor.authn) : undefined);
    return this.check(actor, principal);
  }

  private async users(): Promise<UserPrincipalFactory> {
    if (this.opts.users) {
      return this.opts.users;
    }
    // Sessions may come from another factory, but the target is a users identity either way.
    const registered: unknown = await DI.resolve(PrincipalFactory);
    return registered instanceof UserPrincipalFactory ? registered : new UserPrincipalFactory();
  }
}

async function configuration(): Promise<Configuration> {
  return (await DI.resolve(Configuration)) as Configuration;
}

// A child domain's RBAC is its own: falling back to the parent's would judge the target by another model.
async function registeredInDomain<T>(domain: AccessDomain, token: Class<T>): Promise<T> {
  if (!domain.container.hasRegistered(token, false)) {
    throw new AuthzConfigError(`users: the authz domain ${JSON.stringify(domain.name)} (${ACCESS_DOMAIN_KEY}) has no ${token.name}; register RBAC there (registerRbac) before checking a target`);
  }
  return (await domain.container.resolve(token)) as T;
}

/**
 * Every role the target holds at any scope, with every role those reach. The model's input at GLOBAL carries the stored
 * rows of all the target's subjects (the model's resolver, its subject sets included) whatever their scope.
 */
async function reachableRoles(rbac: RbacService, domain: string, target: Principal): Promise<Set<string>> {
  const now = rbac.model.currentTime();
  const input = await rbac.model.inputAt(target, GLOBAL, scanContext(rbac.model, domain, now));
  const held = input.assignments.filter((a) => a.expiresAt == null || a.expiresAt.getTime() > now.getTime()).map((a) => a.role);
  return closure(rbac.model.roleGraph(), held);
}

// The context RbacService.rolesOf reads with: a read at GLOBAL asks for nothing else; anything more fails, never guesses.
function scanContext(model: RbacModel, domain: string, now: Date): EvaluationContext {
  const known: Partial<EvaluationContext> = { domain, now, cache: new Map(), permissions: model.permissions() };
  return new Proxy(known as EvaluationContext, {
    get(target, key) {
      if (key in target) return target[key as keyof EvaluationContext];
      if (key === 'then') return undefined;
      throw new AuthzConfigError(`users: the target rule reads the roles at GLOBAL only; the RBAC model asked for '${String(key)}'`);
    },
  });
}

function closure(graph: RoleGraph, start: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (out.has(name)) {
      continue;
    }
    out.add(name);
    const role = graph.get(name);
    for (const reached of role?.closure ?? []) {
      queue.push(reached);
      queue.push(...(graph.get(reached)?.def.implies ?? []).map((i) => i.role));
    }
  }
  return out;
}
