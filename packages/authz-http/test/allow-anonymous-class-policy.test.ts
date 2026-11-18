import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { testHost } from '@spinajs/authz-testing';

import { Access, AllowAnonymous, IsAuthenticated } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'anon-lift';
const OWN_POLICY_KEY = 'anonLiftTest.ownAuthentication';

let tenantChecks = 0;

class TenantCheck extends BasePolicy {
  public isEnabled() {
    return true;
  }
  public async execute(req: Request) {
    tenantChecks++;
    if (req.headers['x-tenant'] === 'other') throw new Forbidden('wrong tenant');
  }
}

const ok = () => new Ok({ ok: true });

@BasePath('anon-status')
@Policy(IsAuthenticated)
class StatusRoutes extends BaseController {
  @Get('health')
  @AllowAnonymous()
  public health() {
    return ok();
  }

  @Get('status')
  public status() {
    return ok();
  }

  @Get('own')
  @AllowAnonymous()
  @Policy(IsAuthenticated)
  public own() {
    return ok();
  }

  @Get('own-by-key')
  @AllowAnonymous()
  @Policy(OWN_POLICY_KEY)
  public ownByKey() {
    return ok();
  }
}

@BasePath('anon-tenant')
@Policy([IsAuthenticated, TenantCheck])
class TenantRoutes extends BaseController {
  @Get('health')
  @AllowAnonymous()
  public health() {
    return ok();
  }

  @Get('status')
  public status() {
    return ok();
  }
}

// Other class groups are alternatives (OR) to the IsAuthenticated group, so they stop gating the lifted route.
@BasePath('anon-alternatives')
@Policy(IsAuthenticated)
@Policy(TenantCheck)
@Access('report:read', { domain: D })
class AlternativeRoutes extends BaseController {
  @Get('health')
  @AllowAnonymous()
  public health() {
    return ok();
  }

  @Get('status')
  public status() {
    return ok();
  }
}

@BasePath('anon-class')
@Policy(IsAuthenticated)
@AllowAnonymous()
class ClassAnonymousRoutes extends BaseController {
  @Get('status')
  public status() {
    return ok();
  }
}

describe('@AllowAnonymous on a route under a class-level @Policy(IsAuthenticated)', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    // http admits a configured type name registered as a BasePolicy and resolves it by that name.
    DI.register(IsAuthenticated).as(BasePolicy);
    DI.register(IsAuthenticated).as('IsAuthenticated');
    app = await startApp({ controllers: [StatusRoutes, TenantRoutes, AlternativeRoutes, ClassAnonymousRoutes], config: { [OWN_POLICY_KEY]: 'IsAuthenticated' } });
    // The model permits nothing.
    domain = await createDomain(D, { permissions: { 'report:read': {} } });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    DI.unregister(IsAuthenticated);
    unregisterSource();
  });

  beforeEach(() => {
    tenantChecks = 0;
    domain.model.calls.length = 0;
  });

  it('lets an anonymous request reach the @AllowAnonymous route; the other routes still answer 401', async () => {
    expect((await app.request().get('/anon-status/health')).status).to.eq(200);
    expect((await app.request().get('/anon-status/status')).status).to.eq(401);
  });

  it('lets a request without any principal reach the @AllowAnonymous route', async () => {
    testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
    try {
      expect((await app.request().get('/anon-status/health')).status).to.eq(200);
      expect((await app.request().get('/anon-status/status')).status).to.eq(401);
    } finally {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], true);
    }
  });

  it('keeps admitting an authenticated principal on every route', async () => {
    expect((await app.request().get('/anon-status/health').set('x-user', 'alice')).status).to.eq(200);
    expect((await app.request().get('/anon-status/status').set('x-user', 'alice')).status).to.eq(200);
  });

  it('keeps the other class policies of the group: they still run and can refuse', async () => {
    expect((await app.request().get('/anon-tenant/health')).status).to.eq(200);
    expect(tenantChecks).to.eq(1);

    expect((await app.request().get('/anon-tenant/health').set('x-tenant', 'other')).status).to.eq(403);
    expect((await app.request().get('/anon-tenant/status')).status).to.eq(401);
  });

  it('does not lift an IsAuthenticated the route declares itself', async () => {
    expect((await app.request().get('/anon-status/own')).status).to.eq(401);
  });

  it('does not lift an IsAuthenticated the route names by a configuration key', async () => {
    expect((await app.request().get('/anon-status/own-by-key')).status).to.eq(401);
  });

  it('opens the route even where another class group or a class @Access would refuse: they are alternatives', async () => {
    const health = await app.request().get('/anon-alternatives/health').set('x-tenant', 'other');
    expect(health.status).to.eq(200);
    expect(tenantChecks).to.eq(1);
    expect(domain.model.calls).to.have.length(1);

    expect((await app.request().get('/anon-alternatives/status').set('x-tenant', 'other')).status).to.eq(403);
  });

  it('does not lift the class policy for a class-level @AllowAnonymous', async () => {
    expect((await app.request().get('/anon-class/status')).status).to.eq(401);
  });
});
