import { ClassInfo, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AuthzConfigError, DecisionReplay } from '@spinajs/authz';
import { BaseController, ControllerSource } from '@spinajs/http';

import { DecisionsController } from './decisions-controller.js';

/**
 * Hands the decisions route to http while `authz.http.decisionsRoute.enabled`, in production too (unlike the explain
 * route, it cannot probe a decision that never happened). Enabled without a `DecisionReplay`, the boot fails.
 */
@Injectable(ControllerSource)
export class DecisionsControllerSource extends ControllerSource {
  @Config('authz.http.decisionsRoute.enabled')
  protected Enabled: boolean;

  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    if (this.Enabled !== true) return [];
    if (!DI.check(DecisionReplay)) throw new AuthzConfigError('authz.http.decisionsRoute.enabled is true, but no DecisionReplay is registered; import @spinajs/authz-orm/replay');

    const ci = new ClassInfo<BaseController>();
    ci.name = DecisionsController.name;
    ci.type = DecisionsController;
    // As ExplainControllerSource: no manifest entry, parameter names from the handler.
    ci.file = '<di>';
    return [ci];
  }
}
