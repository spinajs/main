import { ClassInfo, Injectable } from '@spinajs/di';
import { isProduction } from '@spinajs/authz';
import { BaseController, CONTROLLED_DESCRIPTOR_SYMBOL, ControllerSource } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { httpConfig } from '../http-config.js';
import { ExplainController } from './controller.js';

/**
 * Hands the explain route to http only while `authz.http.explainRoute.enabled` and outside
 * production, so in production it is never registered and a request gets 404 (H19, B41).
 */
@Injectable(ControllerSource)
export class ExplainControllerSource extends ControllerSource {
  @Logger('authz-http')
  protected Log: Log;

  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    if (!httpConfig().explainRoute.enabled) return [];
    if (isProduction()) {
      this.Log.warn('authz.http.explainRoute.enabled is true in production; the explain route is not registered');
      return [];
    }

    const ci = new ClassInfo<BaseController>();
    ci.name = ExplainController.name;
    ci.type = ExplainController;
    ci.file = (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, ExplainController.prototype) as IControllerDescriptor | undefined)?.SourceFile ?? '<di>';
    return [ci];
  }
}
