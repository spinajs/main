import { BaseController, BasePath, Get, Middleware } from '@spinajs/http';
import { TenantMiddleware as Guard, TenantRoute } from '../vendor/tenancy-http/index.js';

@BasePath('guard')
@TenantRoute()
export class GuardController extends BaseController {
  @Get('open')
  @Middleware(Guard, { tenancy: 'none' })
  public async open(): Promise<void> {}
}

@BasePath('guard-only')
export class GuardOnlyController extends BaseController {
  @Get('open')
  @Middleware(Guard, { tenancy: 'none' })
  public async open(): Promise<void> {}
}
