import { AuthzConfigError, AuthzDomains, AuthzService, GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AssignmentStore, RbacService, RbacSubjectResolver } from '@spinajs/authz-rbac';
import type { RoleGraph } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

/** The permission an impersonator needs at GLOBAL (B26). */
export const IMPERSONATION_PERMISSION_KEY = 'authz.impersonation.permission';
export const DEFAULT_IMPERSONATION_PERMISSION = 'user:impersonate';

/** Roles whose holders nobody may impersonate or administer (B26, A25). */
export const PROTECTED_ROLES_KEY = 'authz.impersonation.protectedRoles';
export const DEFAULT_PROTECTED_ROLES: readonly string[] = Object.freeze(['admin']);

/** The authz domain whose rights the rule compares; authz-http's key, read here so users needs no authz-http. */
export const ACCESS_DOMAIN_KEY = 'authz.http.access.domain';

export type TargetRuleAnswer = { readonly ok: true } | { readonly ok: false; readonly code: 'protected_role' | 'escalation' };

/** The access domain: its container, and its AuthzService once asked for. */
export interface AccessDomain {
  readonly name: string;
  readonly container: IContainer;
  service(): Promise<AuthzService>;
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

/**
 * The rule an actor passes to act on another account: impersonation (B26) and the credential admin routes (A25, SR-10).
 * `protected_role` when the target holds a protected role (at any scope, directly, through a subject set, or through a
 * role that reaches one by `extends`, a ladder or `implies`); `escalation` when the actor's combined GLOBAL permission set
 * in the access domain does not strictly contain the target's (`AuthzService.covers`, every model, ABAC included).
 *
 * `target` is the principal the actor would act as or on; build it the way the session that uses it will carry it.
 * @throws AuthzConfigError when the access domain has no RbacService or AssignmentStore, or the config is malformed
 */
export class AuthzTargetGuard {
  public async check(actor: Principal, target: Principal): Promise<TargetRuleAnswer> {
    const domain = await accessDomain();
    const rbac = await own(domain, RbacService);
    const assignments = await own(domain, AssignmentStore);
    const authz = await domain.service();

    const guarded = await protectedRoles();
    if (guarded.length > 0) {
      const held = await reachableRoles(rbac, assignments, target);
      if (guarded.some((r) => held.has(r))) {
        return { ok: false, code: 'protected_role' };
      }
    }

    return (await authz.covers(actor, target, GLOBAL)) ? { ok: true } : { ok: false, code: 'escalation' };
  }
}

async function configuration(): Promise<Configuration> {
  return (await DI.resolve(Configuration)) as Configuration;
}

// A child domain's RBAC is its own: falling back to the parent's would judge the target by another model.
async function own<T>(domain: AccessDomain, token: Class<T>): Promise<T> {
  if (!domain.container.hasRegistered(token, false)) {
    throw new AuthzConfigError(`users: the authz domain ${JSON.stringify(domain.name)} (${ACCESS_DOMAIN_KEY}) has no ${token.name}; register RBAC there (registerRbac) before checking a target`);
  }
  return (await domain.container.resolve(token)) as T;
}

/** Every role the target holds at any scope, with every role those reach. */
async function reachableRoles(rbac: RbacService, store: AssignmentStore, target: Principal): Promise<Set<string>> {
  const graph = rbac.model.roleGraph();
  const now = rbac.model.currentTime();
  const resolver = new RbacSubjectResolver();

  const names = new Set((await rbac.rolesOf(target, GLOBAL, { ceiling: false })).map((h) => h.role));
  const rows = await store.forSubjects(resolver.subjects(target), now);
  const sets = [...resolver.memberships(rows, graph, now).values()].map((m) => m.subject);
  const viaSets = sets.length > 0 ? await store.forSubjects(sets, now) : [];
  for (const row of [...rows, ...viaSets]) {
    names.add(row.role);
  }

  return closure(graph, names);
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
