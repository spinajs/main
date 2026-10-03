import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl, PermissionRegistry, RelationRefDecl } from '@spinajs/authz';

import type { GrantIndex } from './grants.js';
import type { RbacModel } from './model.js';
import type { RoleGraph } from './roles.js';

/**
 * Feeds the RBAC model's refs, and those of its extensions, to the boot checks. The host calls it
 * after the permission registry is frozen, so it is also where the grants and the extensions'
 * compile hooks run and a bad grant fails the boot (B02).
 */
export class RbacContributor extends AuthzContributor {
  constructor(private readonly model: RbacModel) {
    super();
  }

  contribute(_domain: string): AuthzContribution {
    const grants = this.model.grantIndex();
    const graph = this.model.roleGraph();
    const permissionRefs: PermissionRefDecl[] = [];
    for (const name of graph.names) {
      for (const { permission } of graph.get(name)!.def.grants) {
        if (!permission.includes('*')) permissionRefs.push({ permission, source: `rbac role '${name}' grant '${permission}'` });
      }
    }
    const out: Record<string, unknown[]> = { permissionRefs, relationRefs: relationRefs(graph, grants, this.model.permissions()) };
    for (const ext of this.model.extensions) {
      for (const [key, list] of Object.entries(ext.contribute?.(graph, grants) ?? {})) {
        if (list === undefined) continue;
        if (!Array.isArray(list)) throw new AuthzConfigError(`An RBAC extension contributed '${key}' that is not an array`);
        out[key] = [...(out[key] ?? []), ...list];
      }
    }
    return out as AuthzContribution;
  }
}

/**
 * One ref per relation of each compiled grant and per type of its permission: the engine resolves a
 * relation through the resolver of the checked resource's type (B05 rule 8). `$global` is left out,
 * it is no type a resolver serves.
 */
function relationRefs(graph: RoleGraph, grants: GrantIndex, registry: PermissionRegistry): RelationRefDecl[] {
  const out = new Map<string, RelationRefDecl>();
  for (const role of graph.names) {
    for (const permission of grants.permissions(role)) {
      const types = registry.require(permission).types;
      for (const g of grants.grants(role, permission)) {
        // Inherited grants are listed under the role that declares them.
        if (g.role !== role) continue;
        const source = `rbac role '${role}' grant '${permission}'${g.def.permission === permission ? '' : ` (from '${g.def.permission}')`}`;
        for (const relation of g.relations ?? []) {
          for (const type of types) out.set(JSON.stringify([type, relation, source]), { type, relation, source });
        }
      }
    }
  }
  return [...out.values()];
}
