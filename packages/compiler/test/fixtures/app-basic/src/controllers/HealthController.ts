import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { AllowAnonymous } from '@spinajs/authz-http';

@BasePath('health')
export class HealthController extends BaseController {
  @Get()
  @AllowAnonymous()
  public async get(): Promise<Ok<{ ok: boolean }>> {
    return new Ok({ ok: true });
  }
}
