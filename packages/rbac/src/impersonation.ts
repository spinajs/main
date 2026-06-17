import { AccessControl } from 'accesscontrol';

export type ImpersonationDenialReason = 'PROTECTED_ROLE' | 'PRIVILEGE_ESCALATION' | 'SELF_TARGET';

export interface IImpersonationCheckOptions {
  /** Roles of the user who wants to impersonate */
  originalRoles: string[];

  /** Roles of the target user */
  targetRoles: string[];

  /** Roles that may never be impersonated (default: ['system']) */
  protectedRoles: string[];

  /** AccessControl instance — used to compare effective grants */
  ac: AccessControl;
}

export interface IImpersonationCheckResult {
  allowed: boolean;
  reason?: ImpersonationDenialReason;
  detail?: string;
}

/**
 * Decides whether `originalRoles` may impersonate a user with `targetRoles`.
 *
 * Rules:
 *  1. If target has any role in `protectedRoles` → denied (PROTECTED_ROLE).
 *  2. If target has any effective grant the original does NOT have, that's an
 *     escalation and impersonation is denied (PRIVILEGE_ESCALATION). This
 *     blocks equal-or-higher targets — admin cannot impersonate admin, user
 *     cannot impersonate admin, but admin can impersonate user.
 *
 * The grant comparison walks accesscontrol's resolved grants, so $extend is
 * honored transitively.
 */
export function canImpersonate(opts: IImpersonationCheckOptions): IImpersonationCheckResult {
  const { originalRoles, targetRoles, protectedRoles, ac } = opts;

  const protectedHit = targetRoles.find(r => protectedRoles.includes(r));
  if (protectedHit) {
    return { allowed: false, reason: 'PROTECTED_ROLE', detail: protectedHit };
  }

  // accesscontrol throws if a role is unknown; guard so unknown target roles
  // (e.g. orphaned data) don't crash the check — treat them as 'no grants'.
  const safePermissions = (roles: string[]) => {
    try {
      return collectPermissions(ac, roles);
    } catch {
      return new Set<string>();
    }
  };

  const targetPerms = safePermissions(targetRoles);
  const originalPerms = safePermissions(originalRoles);

  for (const perm of targetPerms) {
    if (!originalPerms.has(perm)) {
      return { allowed: false, reason: 'PRIVILEGE_ESCALATION', detail: perm };
    }
  }

  // Equal privileges count as escalation per the spec: an impersonator should
  // be strictly more privileged than the target. If target has no role at all
  // (empty grants) we still allow — impersonating a permissionless user is
  // safe by definition.
  if (targetPerms.size > 0 && targetPerms.size === originalPerms.size) {
    return { allowed: false, reason: 'PRIVILEGE_ESCALATION', detail: 'equal privileges' };
  }

  return { allowed: true };
}

/**
 * Build a flat set of "resource::action" strings representing every permission
 * granted to the union of `roles`. Used so we can compare two role sets by
 * simple set inclusion.
 */
function collectPermissions(ac: AccessControl, roles: string[]): Set<string> {
  const out = new Set<string>();
  if (roles.length === 0) return out;

  const grants = ac.getGrants();
  const actions: Array<'createAny' | 'createOwn' | 'readAny' | 'readOwn' | 'updateAny' | 'updateOwn' | 'deleteAny' | 'deleteOwn'> = [
    'createAny', 'createOwn', 'readAny', 'readOwn', 'updateAny', 'updateOwn', 'deleteAny', 'deleteOwn',
  ];

  // Resources are not enumerable directly via the can() API — read them from
  // the raw grants map and walk every $extend chain reachable from `roles`.
  const visited = new Set<string>();
  const stack = [...roles];
  const resources = new Set<string>();

  while (stack.length) {
    const role = stack.pop()!;
    if (visited.has(role)) continue;
    visited.add(role);

    const roleGrants = grants[role];
    if (!roleGrants) continue;

    for (const key of Object.keys(roleGrants)) {
      if (key === '$extend') {
        for (const inherited of roleGrants[key] as string[]) stack.push(inherited);
      } else {
        resources.add(key);
      }
    }
  }

  for (const resource of resources) {
    for (const action of actions) {
      // ac.can(roles)[action](resource).granted is true if ANY of the roles
      // (or their $extend chain) grants the action — exactly the "union of
      // effective permissions" we want.
      if ((ac.can(roles) as any)[action](resource).granted) {
        out.add(`${resource}::${action}`);
      }
    }
  }

  return out;
}
