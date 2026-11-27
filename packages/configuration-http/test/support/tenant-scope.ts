import { RouteMiddleware } from '@spinajs/http';
import type { IMiddlewareContext, MiddlewareStage } from '@spinajs/http';

/**
 * Stands for `TenantMiddleware` of `@spinajs/tenancy-http`: `x-tenant: <id>` runs the request in that tenant's scope,
 * `x-tenant: *` across all tenants, written in `@spinajs/tenancy`'s shape. Without the header no scope is set.
 */
export class TestTenantScope extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  public onBefore(ctx: IMiddlewareContext): void {
    const id = ctx.req.headers['x-tenant'];
    if (typeof id !== 'string') return;
    Reflect.set(ctx.storage, 'Tenant', id === '*' ? { kind: 'all', reason: 'test' } : { kind: 'tenant', tenant: { id } });
  }
}
