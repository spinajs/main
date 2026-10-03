import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution, PermissionRefDecl } from '@spinajs/authz';

import type { RbacModel } from './model.js';

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
    const out: Record<string, unknown[]> = { permissionRefs };
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
