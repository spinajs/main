import { AccessControl } from 'accesscontrol';

import { _collectPermissions } from './util.js';

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
      return _collectPermissions(ac, roles);
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
