import type { Principal } from '@spinajs/authz';

/**
 * Whether `role` passes the principal's `ceiling.roles` (§6.1.2 step 1, B07): the assigned role's
 * own name, never a role it extends, so a ceiling of a lower role does not keep a higher role's
 * assignment. Every contribution step 1 adds must pass it: implied roles and set memberships
 * included (D19).
 */
export function withinCeiling(s: { readonly ceilingRoles?: ReadonlySet<string> }, role: string): boolean {
  return s.ceilingRoles === undefined || s.ceilingRoles.has(role);
}

/**
 * The request principal's ceiling roles; the engine has already narrowed them for a delegate. Names,
 * not globs. Null counts as absent, as in the engine's ceiling reader.
 * @throws Error for a value that is not an array of strings (the engine makes it model_error)
 */
export function ceilingRoles(principal: Principal): ReadonlySet<string> | undefined {
  const roles: unknown = principal.ceiling?.roles;
  if (roles === undefined || roles === null) return undefined;
  if (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string')) throw new Error(`rbac: the ceiling.roles of ${principal.type}:${principal.id} is not a list of role names`);
  return new Set(roles);
}
