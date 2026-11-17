import { isProduction } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Autoinject, ClassInfo, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, ControllerSource } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

import { STUDIO_CONTROLLERS, StudioExplainController } from './controllers/index.js';
import { assertStudioMountable, explainMountable, StudioMountRefused } from './guard.js';
import { STUDIO_SERVICES } from './runtime.js';

/**
 * Hands the Studio controllers to http only while `studio.enabled` and, in production, `studio.allowProduction`,
 * so a disabled Studio registers no route at all (a directory scan could not depend on the setting). In production
 * the explain controller also needs `studio.allowExplainInProduction`.
 */
@Injectable(ControllerSource)
export class StudioControllerSource extends ControllerSource {
  @Logger('studio')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Config('studio.enabled')
  protected Enabled: unknown;

  @Config('studio.allowProduction')
  protected AllowProduction: unknown;

  @Config('studio.allowExplainInProduction')
  protected AllowExplainInProduction: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    if (!this.mountable()) return [];

    for (const service of STUDIO_SERVICES) {
      await this.Container.resolve(service);
    }

    const explain = explainMountable({ allowExplainInProduction: this.AllowExplainInProduction, isProduction: this.production() });
    return STUDIO_CONTROLLERS.filter((type) => explain || type !== StudioExplainController).map((type) => {
      const ci = new ClassInfo<BaseController>();
      ci.name = type.name;
      ci.type = type;
      // Not found in a scanned dir, so no manifest entry: like a DI-registered controller it takes parameter names from the handler.
      ci.file = '<di>';
      return ci;
    });
  }

  protected production(): boolean {
    return isProduction(typeof this.IsProduction === 'boolean' ? this.IsProduction : undefined);
  }

  protected mountable(): boolean {
    try {
      return assertStudioMountable({ enabled: this.Enabled, allowProduction: this.AllowProduction, isProduction: this.production() });
    } catch (e) {
      if (!(e instanceof StudioMountRefused)) throw e;
      this.Log.error(e.message);
      return false;
    }
  }
}
