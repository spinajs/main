import { BaseController, BasePath, Get } from '@spinajs/http';
import { TenantRoute } from '../vendor/tenancy-http/esm/index.js';

@BasePath('nested')
export class NestedController extends BaseController {
  @Get('scoped')
  @TenantRoute()
  public async scoped(): Promise<void> {}
}
