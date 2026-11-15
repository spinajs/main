import { RlsPlanSource, RlsSubjectKeys } from '@spinajs/authz-orm/plan';
import type { AuthorizationModel, ModelListPlan, PermissionDef, PlanTerm, Principal, ResourceType } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { RbacModel } from '../model/model.js';
import { RbacService, modelTables } from '../model/service.js';
import type { CompiledGrant } from '../model/grants.js';
import { RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs } from './args.js';
import type { RbacPlanRole } from './args.js';

const term = (roles: readonly RbacPlanRole[]): PlanTerm => Object.freeze({ op: RBAC_ASSIGNMENT_PLAN_OP, args: rbacPlanArgs({ subjects: [], roles, global: true }) });

function intersect(a: readonly string[] | undefined, b: readonly string[] | undefined): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((t) => b.includes(t));
}

/** The role entries one grant of `role` gives on `type`: one per relation, else one carrying its tag. */
function entriesOf(role: string, scopeTypes: readonly string[] | undefined, g: CompiledGrant): RbacPlanRole[] {
  const types = intersect(scopeTypes, g.grantedAt);
  if (types !== undefined && types.length === 0) return [];
  const base = { role, ...(types ? { scopeTypes: types } : {}) };
  if (g.relations) return g.relations.map((relation) => ({ ...base, relation }));
  return [{ ...base, ...(g.requiresTag !== undefined ? { tag: g.requiresTag } : {}) }];
}

/** The entries of `role` for `permission` on `type`; @throws Error for what no assignment row shows */
function roleEntries(model: RbacModel, role: string, permission: PermissionDef, type: ResourceType): RbacPlanRole[] {
  const grants = model.grantIndex();
  const { ladders, implies } = modelTables(model);
  if (implies?.of(role).some((i) => grants.grants(i.role, permission.name).length > 0)) throw new Error(`rbac: role '${role}' implies a role that grants ${permission.name}; implied roles are not in row level security`);
  const out: RbacPlanRole[] = [];
  for (const g of grants.grants(role, permission.name)) {
    if ((ladders && !ladders.appliesAt(g, type)) || (g.patterns && !g.patterns.some((p) => p.type === type))) continue;
    if (model.configRoles().has(role)) throw new Error(`rbac: role '${role}' comes from authz.rbac.anonymousRoles or serviceRoles, which no assignment row holds`);
    out.push(...entriesOf(role, model.roleGraph().get(role)!.scopeTypes, g));
  }
  return out;
}

/**
 * The RBAC list plan for any principal (`authz:rls`): every role whose grants give `permission` on `type`
 * (its `extends` closure and ladder included), each with the scope types, tag and relation of its grant,
 * at the row, an ancestor, the bare type or $global; deny roles as the exclusion. The subjects come from
 * the session. What the stored assignments cannot show fails as an Error the generator reports (AUTHZ020).
 */
export function rbacRlsPlan(model: RbacModel, permission: PermissionDef, type: ResourceType): ModelListPlan {
  const supported = model.listSupport(permission, type);
  if (supported !== true) throw new Error(supported.reason);
  const graph = model.roleGraph();
  const grants = model.grantIndex();
  const entries = new Map<string, RbacPlanRole>();
  for (const role of graph.names) for (const e of roleEntries(model, role, permission, type)) entries.set(JSON.stringify(e), e);
  const denying = graph.names.filter((r) => grants.denies(r, permission.name)).map((r) => ({ role: r }));
  if (entries.size === 0 && denying.length === 0) return Object.freeze({ kind: 'abstain' });
  return Object.freeze({ kind: 'terms', permit: entries.size === 0 ? [] : [term([...entries.values()])], deny: denying.length === 0 ? [] : [term(denying)] });
}

@Singleton()
@Injectable(RlsPlanSource)
export class RbacRlsPlanSource extends RlsPlanSource {
  readonly model = 'rbac';

  plan(model: AuthorizationModel, permission: PermissionDef, type: ResourceType): ModelListPlan {
    if (!(model instanceof RbacModel)) throw new Error(`rbac: the domain's model 'rbac' is not an RbacModel`);
    return rbacRlsPlan(model, permission, type);
  }
}

/** RBAC's session keys: the principal's own, its companions', the type wildcards and the subject sets it is a member of (RbacService.subjectKeysOf). */
@Singleton()
@Injectable(RlsSubjectKeys)
export class RbacRlsSubjectKeys extends RlsSubjectKeys {
  readonly model = 'rbac';

  keys(model: AuthorizationModel, principal: Principal): Promise<readonly string[]> {
    if (!(model instanceof RbacModel)) return Promise.reject(new Error(`rbac: the domain's model 'rbac' is not an RbacModel`));
    return new RbacService(model).subjectKeysOf(principal);
  }
}
