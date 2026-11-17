import type { AuthzDomains } from '@spinajs/authz';

import type { StudioGraph } from '../contracts/index.js';
import { GraphBuilder } from '../graph/graph.js';
import { bootedService } from './domains.js';

interface RoleDefLike {
  readonly extends: readonly string[];
  readonly grants: readonly { readonly permission: string }[];
  readonly deny?: boolean;
  readonly ladder?: string;
}

/** Structural view of the `RoleGraph` of `@spinajs/authz-rbac`, which Studio does not depend on. */
export interface RoleGraphLike {
  readonly names: readonly string[];
  readonly ladders: readonly { readonly name: string; readonly roles: readonly string[] }[];
  /** `assignable` of the compiled role: a definition may leave it out. */
  get(name: string): { readonly def: RoleDefLike; readonly assignable: boolean } | undefined;
}

export const roleId = (name: string): string => `role:${name}`;
export const permId = (permission: string): string => `perm:${permission}`;

export function isRbacModel(model: unknown): model is { roleGraph(): RoleGraphLike } {
  return typeof model === 'object' && model !== null && 'roleGraph' in model && typeof model.roleGraph === 'function';
}

export function rbacRolesOf(domains: AuthzDomains, domain: string): RoleGraphLike | undefined {
  for (const model of bootedService(domains, domain)?.models() ?? []) if (isRbacModel(model)) return model.roleGraph();
  return undefined;
}

/** Role names, permission names and the edges between them; never a grant's resource pattern, fields or relation. */
export function rolesGraph(graph: RoleGraphLike): StudioGraph {
  const b = new GraphBuilder();
  for (const name of graph.names) {
    const role = graph.get(name);
    if (!role) continue;
    const def = role.def;
    b.node({ id: roleId(name), label: name, kind: 'role', ...(def.ladder ? { group: def.ladder } : {}), attributes: { assignable: role.assignable, deny: def.deny === true } });
    for (const grant of def.grants) {
      b.node({ id: permId(grant.permission), label: grant.permission, kind: 'permission', attributes: {} });
      b.edge(roleId(name), permId(grant.permission), 'grants');
    }
  }
  for (const name of graph.names) for (const parent of graph.get(name)?.def.extends ?? []) b.edge(roleId(name), roleId(parent), 'inherits');
  // A ladder lists its roles weakest first, and a role holds the grants of every lower one: one edge per step.
  for (const ladder of graph.ladders) for (let i = 1; i < ladder.roles.length; i++) b.edge(roleId(ladder.roles[i]), roleId(ladder.roles[i - 1]), 'ladder', ladder.name);
  return b.build('runtime');
}
