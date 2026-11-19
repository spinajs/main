import { BaseController, BasePath, Get, Middleware } from '@spinajs/http';
import { TenantRoute } from '../vendor/tenancy-http/index.js';

class TenantMiddleware {}

@BasePath('foreign-mount')
@TenantRoute()
export class ForeignMountController extends BaseController {
  @Get('open')
  @Middleware(TenantMiddleware, { tenancy: 'none' })
  public async open(): Promise<void> {}
}
