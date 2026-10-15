import { compilePermissionGlob } from '@spinajs/authz';
import type { ListSupport, Permission, ResourceType, RuleDef } from '@spinajs/authz';

import type { GrantIndex } from '../grants.js';
import type { ImpliesIndex } from '../ladder/implies.js';
import type { LadderIndex } from '../ladder/ladders.js';
import type { RoleGraph } from '../roles.js';

export const LIST_RELATIONS: ReadonlySet<string> = new Set(['owner', 'self']);

export interface ListSupportSources {
  readonly graph: RoleGraph;
  readonly grants: GrantIndex;
  readonly ladders?: LadderIndex;
  readonly implies?: ImpliesIndex;
  /** The in-memory rules; DB rules are refused when written (RbacRuleListGuard). */
  readonly rules: readonly RuleDef[];
}

/** Whether a rule can change the answer for `permission` on `type`: restrict and cap act on every permission, a threshold on its own. */
export function ruleCanMatch(rule: Pick<RuleDef, 'kind' | 'resourceTypes' | 'permissions'>, permission: Permission, type: ResourceType): boolean {
  if (rule.resourceTypes && !rule.resourceTypes.includes(type)) return false;
  if (rule.kind !== 'threshold') return true;
  return (rule.permissions ?? []).some((glob) => compilePermissionGlob(glob)(permission));
}

/** Design §7 for RBAC: why `permission` on `type` cannot be planned (lane L8 decisions 7 and 9), or true. */
export function rbacListSupport(src: ListSupportSources, permission: Permission, type: ResourceType): ListSupport {
  const refuse = (text: string): ListSupport => Object.freeze({ reason: `${text}, so ${permission} on ${JSON.stringify(type)} is not list-filterable` });
  for (const rule of src.rules) {
    if (ruleCanMatch(rule, permission, type)) return refuse(`rbac rule '${rule.id}' (${rule.kind}, source: ${rule.source}) can apply to it; lists cannot follow rules`);
  }
  const impliedTags = new Set<string>();
  if (src.implies) for (const name of src.graph.names) for (const e of src.implies.of(name)) for (const t of e.tags) impliedTags.add(t);
  for (const role of src.graph.names) {
    for (const g of src.grants.grants(role, permission)) {
      // Each grant is judged once, under the role that declares it.
      if (g.role !== role || (src.ladders && !src.ladders.appliesAt(g, type))) continue;
      const where = `rbac role '${role}' grant '${g.def.permission}' (source: ${src.graph.get(role)!.def.source})`;
      const other = g.relations?.find((r) => !LIST_RELATIONS.has(r));
      if (other !== undefined) return refuse(`${where} has the relation '${other}'; lists support owner and self only (assign a role on the resource instead)`);
      if (g.patterns?.some((p) => p.id !== undefined)) return refuse(`${where} limits \`on\` by id; lists support type-only patterns`);
      if (g.requiresTag !== undefined && g.grantedAt !== undefined) return refuse(`${where} has both requiresTag and grantedAt`);
      if (g.relations && (g.requiresTag !== undefined || g.grantedAt !== undefined)) return refuse(`${where} joins a relation with requiresTag or grantedAt`);
      if (g.requiresTag !== undefined && impliedTags.has(g.requiresTag)) return refuse(`${where} requires tag '${g.requiresTag}', which an implied role also carries`);
    }
  }
  return true;
}
