import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, CONTROLLED_DESCRIPTOR_SYMBOL, Get, Middleware, Ok, resolveRouteMiddlewares } from '@spinajs/http';
import type { IController, IControllerDescriptor } from '@spinajs/http';
import type { TestApp } from '@spinajs/testing';
import { AllTenants, NoTenant, TenantMiddleware, TenantRoute } from '../src/index.js';
import type { TenantRouteDeclaration } from '../src/index.js';
import { tenancyHttpApp } from './support/source.js';

@TenantRoute()
@BasePath('mixed')
class MixedRoutes extends BaseController {
  @Get('plain')
  public plain() {
    return new Ok(null);
  }

  @NoTenant()
  @Get('open')
  public open() {
    return new Ok(null);
  }

  @AllTenants('  nightly report  ')
  @Get('report')
  public report() {
    return new Ok(null);
  }

  @Middleware(TenantMiddleware, { tenancy: 'none' })
  @Get('by-hand')
  public byHand() {
    return new Ok(null);
  }
}

@BasePath('bare')
class BareRoutes extends BaseController {
  @Get('plain')
  public plain() {
    return new Ok(null);
  }

  @NoTenant()
  @Get('open')
  public open() {
    return new Ok(null);
  }
}

@NoTenant()
@BasePath('closed')
class ClosedRoutes extends BaseController {
  @Middleware(TenantMiddleware)
  @Get('by-hand')
  public byHand() {
    return new Ok(null);
  }
}

describe('tenant route declarations', () => {
  let app: TestApp;

  // The middlewares a route gets, as BaseController resolves them: the global entry, the controller's, the route's.
  async function mounted(type: abstract new () => BaseController, method: string): Promise<TenantRouteDeclaration[]> {
    const descriptor = Reflect.getOwnMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, type.prototype as object) as IControllerDescriptor;
    const route = descriptor.Routes.get(method);
    if (!route) throw new Error(`no route ${method}`);
    const controller = { Descriptor: descriptor } as IController;
    const resolved = await resolveRouteMiddlewares(descriptor, route, app.container, [{ Type: TenantMiddleware, Options: [] }]);
    return resolved.filter((m): m is TenantMiddleware => m instanceof TenantMiddleware && m.isEnabled(route, controller)).map((m) => m.declaration);
  }

  before(async () => {
    app = await tenancyHttpApp();
  });

  after(async () => {
    await app?.dispose();
  });

  it('requires a tenant on a route without a declaration, through the global entry', async () => {
    expect(await mounted(BareRoutes, 'plain')).to.deep.eq([{ tenancy: 'required' }]);
  });

  it('mounts the route declaration in place of the global entry', async () => {
    expect(await mounted(BareRoutes, 'open')).to.deep.eq([{ tenancy: 'none' }]);
  });

  it('applies the controller declaration to its routes', async () => {
    expect(await mounted(MixedRoutes, 'plain')).to.deep.eq([{ tenancy: 'required' }]);
  });

  it('lets the route declaration win over the controller, with exactly one middleware mounted', async () => {
    expect(await mounted(MixedRoutes, 'open')).to.deep.eq([{ tenancy: 'none' }]);
    expect(await mounted(MixedRoutes, 'report')).to.deep.eq([{ tenancy: 'all', reason: 'nightly report' }]);
  });

  it('lets a hand-written @Middleware(TenantMiddleware) on the route decide over the controller declaration', async () => {
    expect(await mounted(MixedRoutes, 'byHand')).to.deep.eq([{ tenancy: 'none' }]);
    expect(await mounted(ClosedRoutes, 'byHand')).to.deep.eq([{ tenancy: 'required' }]);
  });

  it('needs a reason for @AllTenants', () => {
    expect(() => AllTenants('  ')).to.throw(InvalidArgument, '@AllTenants needs a reason');
  });
});
