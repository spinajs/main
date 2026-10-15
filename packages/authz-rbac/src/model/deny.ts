import { DEFAULT_DENY_PRIORITY, TRUE } from '@spinajs/authz';
import type { DenyReason } from '@spinajs/authz';

import type { RbacStep } from './evaluate.js';
import { scopeMatcher } from './native.js';
import type { RoleGraph } from './roles.js';
import { underTerm } from './rows.js';

export const isDenyRole = (roles: RoleGraph, role: string): boolean => roles.get(role)?.def.deny === true;

export function roleDenied(roles: readonly string[]): DenyReason {
  return { code: 'role_denied', role: [...roles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0], priority: DEFAULT_DENY_PRIORITY.role_denied };
}

/**
 * Design §4.2: a live assignment of a deny role naming the permission denies it at its scope and below,
 * over every permit. On the path it denies the request (every row of a type-level one); off the path of a
 * type-level request it denies the rows under its scope.
 */
export const applyDenyRoles: RbacStep = (s) => {
  const covering = s.denied.filter((l) => s.input.grants.denies(l.role, s.permission));
  if (covering.length === 0) return;
  const type = s.input.request.resource.type;
  const onPath = scopeMatcher(type, s.input.path);
  const here = covering.filter((l) => onPath(l.scope));
  s.denies.push({ when: here.length > 0 ? TRUE : underTerm(covering, type), reason: roleDenied((here.length > 0 ? here : covering).map((l) => l.role)) });
  const ends = covering.flatMap((l) => (l.expiresAt ? [l.expiresAt.getTime()] : []));
  if (s.validUntil) ends.push(s.validUntil.getTime());
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
};
