import { isPermission } from '@spinajs/authz';
import type { AdminContext, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { roleClosure, roleIndex } from './common.js';

/** What DefaultAdminGuard needs to know about the actor; L1's RbacService is expected to back it exactly (hand-off). */
export abstract class RbacAdminFacts {
  /** The actor holds every permission `role` grants (closure) at `scope`, unconditionally. */
  abstract covers(actor: Principal, role: string, scope: ResourceRef, ctx: AdminContext): Promise<boolean>;
  /** The actor's effective role on `ladder` at `scope`, or undefined when it holds none. */
  abstract effectiveRole(actor: Principal, ladder: string, scope: ResourceRef, ctx: AdminContext): Promise<string | undefined>;
}

const unconditional = (d: Decision | undefined): boolean => d?.allowed === true && d.residual?.op === 'true';

/**
 * RbacAdminFacts from checks through ctx.authz. Fails closed where checks cannot answer without the
 * permission registry: a glob grant, an undefined role in the closure or a check that throws (a permission
 * whose types exclude the scope type) counts as not covered.
 */
@Singleton()
@Injectable(RbacAdminFacts)
export class CheckRbacAdminFacts extends RbacAdminFacts {
  async covers(actor: Principal, role: string, scope: ResourceRef, ctx: AdminContext): Promise<boolean> {
    const { defs, unknown } = roleClosure(await roleIndex(ctx), role);
    if (unknown.length > 0) return false;
    const wanted = new Set<Permission>();
    for (const def of defs) {
      for (const g of def.grants) {
        if (!isPermission(g.permission)) return false;
        wanted.add(g.permission);
      }
    }
    if (wanted.size === 0) return true;
    try {
      const decisions = await ctx.authz.checkMany(actor, [...wanted], scope);
      return [...wanted].every((p) => unconditional(decisions.get(p)));
    } catch {
      return false;
    }
  }

  /** Decision.roles is filled for every outcome (D-F5-8), so a check of any permission of the ladder answers. */
  async effectiveRole(actor: Principal, ladder: string, scope: ResourceRef, ctx: AdminContext): Promise<string | undefined> {
    const roles = await roleIndex(ctx);
    const tried = new Set<Permission>();
    for (const name of roles.ladders.get(ladder)?.roles ?? []) {
      for (const def of roleClosure(roles, name).defs) {
        for (const { permission } of def.grants) {
          if (!isPermission(permission) || tried.has(permission)) continue;
          tried.add(permission);
          try {
            return (await ctx.authz.check({ principal: actor, permission, resource: scope })).roles?.[ladder];
          } catch {
            // Not checkable at this scope; try the next permission.
          }
        }
      }
    }
    return undefined;
  }
}
