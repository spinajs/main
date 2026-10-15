import { AuthzConfigError } from '@spinajs/authz';
import type { EvaluationContext, ListPlanRequest, ListSupport, ModelListPlan, Permission, PermissionDef, Principal, ResourceType } from '@spinajs/authz';

import { StaticModel } from './static-model.js';
import type { StaticModelOptions } from './static-model.js';

export type ListPlanScript = ModelListPlan | ((principal: Principal, type: ResourceType, req: ListPlanRequest) => ModelListPlan | Promise<ModelListPlan>);

export interface ListStaticModelOptions extends StaticModelOptions {
  /** By permission name; `listSupport` answers true for exactly these. */
  readonly lists?: Readonly<Record<Permission, ListPlanScript>>;
}

/** StaticModel with scripted list plans. StaticModel itself has no listSupport, so boot rule 12 refuses it for list permissions. */
export class ListStaticModel extends StaticModel {
  constructor(private readonly listOpts: ListStaticModelOptions = {}) {
    super(listOpts);
  }

  listSupport(permission: PermissionDef, _type: ResourceType): ListSupport {
    return this.listOpts.lists && Object.hasOwn(this.listOpts.lists, permission.name) ? true : { reason: `static model ${this.name} has no list plan for '${permission.name}'` };
  }

  async listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan> {
    this.calls.push({ method: 'listPlan', args: [req, ctx] });
    const script = this.listOpts.lists?.[req.permission.name];
    if (script === undefined) throw new AuthzConfigError(`static model ${this.name}: no list plan for '${req.permission.name}'`);
    return typeof script === 'function' ? script(req.principal, req.type, req) : script;
  }
}
