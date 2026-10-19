import { AuthzAdminFailure, GLOBAL, SYSTEM, UnknownPermission, invalid, isPermission, isPermissionGlob, readExpiry, readId, readPrincipal, readScope } from '@spinajs/authz';
import type { AdminContext, ResourceRef, ResourceType } from '@spinajs/authz';

import type { AssignmentSubject, RoleDef } from '../contracts.js';
import { isPlainObject as isObject, quote as q } from './common.js';
import type { RoleIndex } from './role-index.js';
import { sortedTags } from './rows.js';

/** A principal, or a subject set; with `roles`, the set's role must exist and be a subject set role. */
export function readSubject(v: unknown, field: string, roles?: RoleIndex): AssignmentSubject {
  if (isObject(v) && v.set !== undefined) {
    const set = v.set;
    if (!isObject(set)) throw invalid(`${field}.set`, `${field}.set must be { role, scope }`);
    const role = readId(set.role, `${field}.set.role`);
    const scope = readScope(set.scope, `${field}.set.scope`);
    if (roles && roles.roles.get(role)?.subjectSet !== true) throw new AuthzAdminFailure('unknown_role', `${q(role)} is not a subject set role`, `${field}.set.role`);
    return { set: { role, scope } };
  }
  return readPrincipal(v, field);
}

export function readTags(v: unknown, field = 'tags'): string[] {
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string' && t !== '' && !t.includes(','))) throw invalid(field, `${field} must be non-empty strings without ','`);
  return sortedTags(v as string[]);
}

export function readOptionalTags(v: unknown, field = 'tags'): string[] | undefined {
  return v === undefined ? undefined : readTags(v, field);
}

/** As readExpiry, but a date at or before now is refused: it would be a revoke the guard does not see as one. */
export function readFutureExpiry(v: unknown, ctx: AdminContext, field = 'expiresAt'): Date | null | undefined {
  const at = readExpiry(v, field);
  if (at && at.getTime() <= ctx.now.getTime()) throw invalid(field, `${field} must lie after now; revoke instead`);
  return at;
}

export function readAttributes(v: unknown, field = 'attributes'): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) throw invalid(field, `${field} must be an object`);
  return structuredClone(v);
}

/** The role exists, is assignable, and may be held at the scope's type (GLOBAL is type $global). */
export function checkGrantable(roles: RoleIndex, role: unknown, scope: ResourceRef, field = 'role'): RoleDef {
  const name = readId(role, field);
  const def = roles.roles.get(name);
  if (!def) throw new AuthzAdminFailure('unknown_role', `role ${q(name)} does not exist`, field);
  if (!def.assignable) throw new AuthzAdminFailure('not_assignable', `role ${q(name)} cannot be assigned`, field);
  const types: readonly ResourceType[] | undefined = def.scopeTypes;
  if (types !== undefined && !types.includes(scope.type)) throw new AuthzAdminFailure('wrong_scope_type', `role ${q(name)} is held at ${types.join(', ')}, not at ${scope.type}`, field);
  return def;
}

/** A literal name is known when the engine does not throw UnknownPermission for it (SYSTEM checks look it up first). */
export async function checkPermissionName(ctx: AdminContext, name: unknown, field: string): Promise<void> {
  if (typeof name === 'string' && name.includes('*')) {
    if (!isPermissionGlob(name)) throw new AuthzAdminFailure('unknown_permission', `${q(name)} is not a permission glob`, field);
    return;
  }
  if (!isPermission(name)) throw new AuthzAdminFailure('unknown_permission', `${q(name)} is not a permission name`, field);
  try {
    // At GLOBAL: without a resource the engine checks the name's prefix as the type, which need not be one of its types.
    await ctx.authz.can(SYSTEM, name, GLOBAL);
  } catch (e) {
    if (e instanceof UnknownPermission) throw new AuthzAdminFailure('unknown_permission', `permission ${q(name)} is not registered`, field);
    throw e;
  }
}
