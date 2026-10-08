import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import type { RbacModel } from '../model/model.js';
import type { RoleGraph } from '../model/roles.js';

/**
 * The role definitions of the RbacModel whose residuals reach SQL for `model`. The model lives per
 * domain and a query does not say which domain it runs in, so the host registers this; there is no
 * default. Another model's definitions can widen the list, so a source must answer only for the ORM
 * models whose residuals come from its RbacModel. With several RbacModels, register the source in
 * the domain container and resolve the compiler there.
 */
export abstract class RbacRoleGraphSource {
  /** undefined: not compiled yet, or not this source's model; the compiler then throws (fail closed). */
  abstract graph(model: Class<ModelBase>): RoleGraph | undefined;
}

/**
 * The current graph of one RbacModel, reloads included, for the ORM models in `serves` only.
 * Register it with a factory:
 * `container.register(() => new RbacModelRoleGraphSource(rbac, [DocModel])).as(RbacRoleGraphSource)`.
 */
export class RbacModelRoleGraphSource extends RbacRoleGraphSource {
  private readonly serves: (model: Class<ModelBase>) => boolean;

  constructor(private readonly rbac: RbacModel, serves: readonly Class<ModelBase>[] | ((model: Class<ModelBase>) => boolean)) {
    super();
    if (typeof serves === 'function') {
      this.serves = serves;
    } else {
      const models = new Set(serves);
      this.serves = (model) => models.has(model);
    }
  }

  graph(model: Class<ModelBase>): RoleGraph | undefined {
    return this.serves(model) ? this.rbac.roleGraph() : undefined;
  }
}

/** The roles of a term as SQL must check them: where each one's definition accepts an assignment. */
export interface RbacRoleScopes {
  /** Assignable at every scope type. */
  readonly anyScope: readonly string[];
  /** Assignable only at the listed scope types (`scopeTypes`, `'$global'` included when listed). */
  readonly scoped: readonly { readonly role: string; readonly scopeTypes: readonly ResourceType[] }[];
}

/**
 * `assignmentProblem` of model/roles.ts as constants: a role with no definition or not assignable
 * is dropped, so no assignment of it counts.
 */
export function rbacRoleScopes(graph: RoleGraph, roles: readonly string[]): RbacRoleScopes {
  const anyScope: string[] = [];
  const scoped: { role: string; scopeTypes: readonly ResourceType[] }[] = [];
  for (const role of new Set(roles)) {
    const def = graph.get(role);
    if (!def || !def.assignable) continue;
    if (def.scopeTypes) scoped.push({ role, scopeTypes: [...new Set(def.scopeTypes)] });
    else anyScope.push(role);
  }
  return { anyScope, scoped };
}

export const isEmptyRoleScopes = (r: RbacRoleScopes): boolean => r.anyScope.length === 0 && r.scoped.length === 0;
