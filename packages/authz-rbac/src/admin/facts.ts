import { AuthzConfigError, isPermission } from '@spinajs/authz';
import type { AdminContext, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { grantClosure, ladderAppliesAt, rankOf, roleClosure, roleIndex } from './common.js';

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
 * permission registry: a glob grant, an undefined role in the closure, an implied role that bypasses
 * restrict or cap rules, or a check refused as a configuration error (a permission whose types exclude the
 * scope type) counts as not covered. Any other error of a check rejects. The implied roles of a ladder role
 * the actor ranks at or above are not followed (grantClosure).
 */
@Singleton()
@Injectable(RbacAdminFacts)
export class CheckRbacAdminFacts extends RbacAdminFacts {
  async covers(actor: Principal, role: string, scope: ResourceRef, ctx: AdminContext): Promise<boolean> {
    const roles = await roleIndex(ctx);
    const own = new Map<string, Promise<string | undefined>>();
    const holds = async (ladder: string, name: string): Promise<boolean> => {
      if (!ladderAppliesAt(roles, ladder, scope)) return false;
      if (!own.has(ladder)) own.set(ladder, this.effectiveRole(actor, ladder, scope, ctx));
      const mine = await own.get(ladder)!;
      return mine !== undefined && rankOf(roles, ladder, name) >= 0 && rankOf(roles, ladder, mine) >= rankOf(roles, ladder, name);
    };
    // A `descendants` implied role is not held at the scope, but checks reach no lower; L1 judges it exactly.
    const { defs, unknown, bypass } = await grantClosure(roles, role, holds);
    if (unknown.length > 0 || bypass) return false;
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
    } catch (e) {
      if (e instanceof AuthzConfigError) return false;
      throw e;
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
          } catch (e) {
            // Not checkable at this scope; try the next permission.
            if (!(e instanceof AuthzConfigError)) throw e;
          }
        }
      }
    }
    return undefined;
  }
}
