import { Autoinject, Container, Injectable, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { RouteMiddleware } from '@spinajs/http';
import type { IController, IMiddlewareContext, IMiddlewareDescriptor, IRoute, MiddlewareStage } from '@spinajs/http';
import { TENANCY_DEFAULTS, TenantUnavailable, allTenantsScope, tenantScopeOf } from '@spinajs/tenancy';
import type { TenantRecord, TenantResolver } from '@spinajs/tenancy';
import { resolveTenant } from './admission.js';
import { TenantRefused } from './refusal.js';
import { tenantResolvers } from './resolvers.js';
import { httpSource } from './source.js';
import './storage.js';

/** What a route says about its tenancy; `@TenantRoute()`, `@NoTenant()` and `@AllTenants(reason)` write it. */
export type TenantRouteDeclaration = { readonly tenancy: 'required' } | { readonly tenancy: 'none' } | { readonly tenancy: 'all'; readonly reason: string };

const REQUIRED: TenantRouteDeclaration = { tenancy: 'required' };

function declared(middlewares: readonly IMiddlewareDescriptor[] | undefined): unknown {
  const own = (middlewares ?? []).filter((m) => m.Type === TenantMiddleware);
  if (own.length === 0) return undefined;
  const declaration: unknown = own[own.length - 1].Options[0];
  return declaration ?? REQUIRED;
}

/**
 * Establishes the tenant scope of a request before the policy gate. Mounted on every route by
 * `http.routes.middlewares: ['TenantMiddleware']`, where a tenant is then required, or by a decorator.
 */
@NewInstance()
@Injectable(RouteMiddleware)
export class TenantMiddleware extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  @Autoinject(Container)
  protected Container: IContainer;

  @Config('tenancy.http.resolvers', { defaultValue: TENANCY_DEFAULTS.http.resolvers })
  protected ResolverNames: readonly string[];

  @Config('tenancy.http.unknownTenant', { defaultValue: TENANCY_DEFAULTS.http.unknownTenant })
  protected UnknownTenant: number;

  protected Resolvers: TenantResolver[] = [];

  constructor(public readonly declaration: TenantRouteDeclaration = REQUIRED) {
    super();
  }

  public async resolve(): Promise<void> {
    if (this.declaration.tenancy === 'required') {
      this.Resolvers = await tenantResolvers(this.ResolverNames, this.Container);
    }
    await super.resolve();
  }

  // A route's own declaration wins over its controller's: the instance of the one that lost is not mounted.
  public override isEnabled(route: IRoute, controller: IController): boolean {
    const effective = declared(route.Middlewares) ?? declared(controller.Descriptor.Middlewares);
    return effective === undefined || effective === this.declaration;
  }

  // The action, onAfter and onFinish run with req.storage as their store, and authz's AccessPolicy enters it too:
  // a scope written here is the scope of everything after this middleware.
  public async onBefore(ctx: IMiddlewareContext): Promise<void> {
    const declaration = this.declaration;
    if (declaration.tenancy === 'none') {
      delete ctx.storage.Tenant;
      return;
    }
    if (declaration.tenancy === 'all') {
      ctx.storage.Tenant = allTenantsScope(declaration.reason);
      return;
    }
    ctx.storage.Tenant = tenantScopeOf(await this.admit(ctx));
  }

  protected async admit(ctx: IMiddlewareContext): Promise<TenantRecord> {
    const status = this.UnknownTenant === 403 ? 403 : 404;
    try {
      const tenant = await resolveTenant(this.Resolvers, httpSource(ctx), this.Container);
      if (tenant) return tenant;
    } catch (err) {
      if (err instanceof TenantUnavailable) throw new TenantRefused(status, err);
      throw err;
    }
    throw new TenantRefused(status, new TenantUnavailable('unknown', 'the request names no tenant'));
  }
}
