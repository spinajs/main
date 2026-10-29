import { BaseController, BasePath, Get } from '@spinajs/http';
import { AllowAnonymous } from '@spinajs/authz-http';

@BasePath('health')
export class HealthController extends BaseController {
  @Get()
  @AllowAnonymous()
  public async get(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
