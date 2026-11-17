import { BaseController, BasePath, Get, Middleware, Post } from '@spinajs/http';
import { AllTenants, NoTenant, TenantMiddleware, TenantRoute, TenantRoute as Scoped } from '../vendor/tenancy-http/index.js';

declare function reasonOf(): string;

@BasePath('invoices')
export class InvoicesController extends BaseController {
  @Get(':id')
  public async get(): Promise<void> {}

  @Get('mine')
  @TenantRoute()
  public async mine(): Promise<void> {}

  @Get('aliased')
  @Scoped()
  public async aliased(): Promise<void> {}

  @Get('status')
  @NoTenant()
  public async status(): Promise<void> {}

  @Post('report')
  @AllTenants('monthly revenue report')
  public async report(): Promise<void> {}

  @Post('dynamic')
  @AllTenants(reasonOf())
  public async dynamic(): Promise<void> {}
}

@AllTenants('operator console')
export abstract class OperatorController extends BaseController {
  @Get('health')
  @NoTenant()
  public async health(): Promise<void> {}
}

@BasePath('admin')
export class AdminController extends OperatorController {
  @Get('tenants')
  public async tenants(): Promise<void> {}

  @Get('me')
  @TenantRoute()
  public async me(): Promise<void> {}
}

@Middleware(TenantMiddleware, { tenancy: 'none' })
export abstract class HandMountedController extends BaseController {
  @Get('ping')
  public async ping(): Promise<void> {}
}

@BasePath('ops')
export class OpsController extends HandMountedController {
  @Get('stats')
  public async stats(): Promise<void> {}
}

@BasePath('guarded')
@TenantRoute()
export class GuardedController extends BaseController {
  @Get('open')
  @Middleware(TenantMiddleware, { tenancy: 'none' })
  public async open(): Promise<void> {}

  @Get('scoped')
  public async scoped(): Promise<void> {}
}

@TenantRoute()
export abstract class ScopedBaseController extends BaseController {
  @Get('kept')
  public async kept(): Promise<void> {}

  @Get('method')
  @TenantRoute()
  public async method(): Promise<void> {}
}

@BasePath('unscoped')
@Middleware(TenantMiddleware, { tenancy: 'none' })
export class UnscopedController extends ScopedBaseController {}

@BasePath('redeclared')
export class RedeclaredController extends ScopedBaseController {
  @Middleware(TenantMiddleware, { tenancy: 'none' })
  public override async method(): Promise<void> {}
}
