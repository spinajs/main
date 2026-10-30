import { ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { isProduction } from '@spinajs/authz';
import { BaseController, ControllerSource } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { ExplainController } from './controller.js';

/**
 * Hands the explain route to http only while `authz.http.explainRoute.enabled` and outside
 * production, so in production it is never registered and a request gets 404 (H19, B41).
 */
@Injectable(ControllerSource)
export class ExplainControllerSource extends ControllerSource {
  @Logger('authz-http')
  protected Log: Log;

  @Config('authz.http.explainRoute.enabled')
  protected ExplainEnabled: boolean;

  @Config('configuration.isProduction')
  protected IsProduction: boolean | undefined;

  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    // The schema is the gate; this holds for a value that never went through it ('false', 1).
    if (this.ExplainEnabled !== true) return [];
    if (isProduction(this.IsProduction)) {
      this.Log.warn('authz.http.explainRoute.enabled is true in production; the explain route is not registered');
      return [];
    }

    const ci = new ClassInfo<BaseController>();
    ci.name = ExplainController.name;
    ci.type = ExplainController;
    // Handed over by this source, not found in a scanned dir, so it has no manifest entry: like a DI-registered controller it
    // takes its parameter names from the handler, which keeps `require` mode from asking the manifest or typescript.
    ci.file = '<di>';
    return [ci];
  }
}
