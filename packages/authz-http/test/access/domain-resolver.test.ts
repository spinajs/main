import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { DecisionRequest } from '@spinajs/authz';
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { Access, AccessController, AuthzDomainResolver, StaticDomainResolver, typedExtractor } from '../../src/index.js';
import { startApp, stopApp } from '../support/app.js';
import type { TestApp } from '../support/app.js';
import { createDomain } from '../support/domain.js';
import type { TestDomain } from '../support/domain.js';
import { TenantResolver, registerTenantResolver } from '../support/domain-resolver.js';
import { registerHeaderSource } from '../support/principals.js';

const BASE = 'base';
const A = 'tenant-a';
const B = 'tenant-b';

const permissions = { 'file:read': {}, 'authz:explain': {} };
const byParam = (type: string) => typedExtractor(type, (req) => ({ type, id: req.params.id }));

// tenant-a permits file:read to everyone and authz:explain to bob; the base and tenant-b domains permit nothing.
const denying = (): ScriptedVote => ({});
const permitting = (req: DecisionRequest): ScriptedVote => (req.permission === 'file:read' || req.principal.id === 'bob' ? { permitWhen: { op: 'true' } } : {});

const resultsOf = (res: { body: unknown }) => (res.body as { results: boolean[] }).results;

const decision = (req: Request) => new Ok({ allowed: req.storage.AuthzDecision?.allowed ?? null, domain: req.storage.AuthzDecision?.domain ?? null });

@BasePath('tenant')
class TenantRoutes extends BaseController {
  @Get('files/:id')
  @Access('file:read', { domain: BASE, resource: byParam('file') })
  public routeDomain(@Req() req: Request) {
    return decision(req);
  }

  @Get('anywhere')
  @Access('file:read')
  public noDomain(@Req() req: Request) {
    return decision(req);
  }
}

@BasePath('klass')
@Access('file:read', { domain: BASE })
class ClassRoutes extends BaseController {
  @Get('files')
  public files(@Req() req: Request) {
    return decision(req);
  }
}

describe('AuthzDomainResolver (B48)', function () {
  this.timeout(30000);

  describe('default', () => {
    it('is the static resolver, which returns the fallback', async () => {
      DI.uncache(AuthzDomainResolver);
      const resolver = await DI.resolve<AuthzDomainResolver>(AuthzDomainResolver);

      expect(resolver).to.be.instanceOf(StaticDomainResolver);
      expect(await resolver.resolve({} as Request, 'fs')).to.eq('fs');
    });
  });

  describe('@Access routes', () => {
    let app: TestApp;
    let domains: TestDomain[];
    let unregisterSource: () => void;
    let unregisterResolver: () => void;

    before(async () => {
      unregisterSource = registerHeaderSource();
      unregisterResolver = registerTenantResolver();
      app = await startApp({ controllers: [TenantRoutes, ClassRoutes] });
      domains = [await createDomain(BASE, { permissions, model: { votes: denying } }), await createDomain(A, { permissions, model: { votes: permitting } }), await createDomain(B, { permissions, model: { votes: denying } })];
    });

    after(async () => {
      for (const d of domains ?? []) await d.dispose();
      await stopApp();
      unregisterResolver();
      unregisterSource();
    });

    beforeEach(() => {
      TenantResolver.fallbacks.length = 0;
    });

    const get = (path: string, tenant?: string) => {
      const r = app.request().get(path).set('x-user', 'alice');
      return tenant === undefined ? r : r.set('x-tenant', tenant);
    };

    it('checks in the domain the resolver names, and records it in the decision', async () => {
      const res = await get('/tenant/files/f1', A);

      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ allowed: true, domain: A });
    });

    it('denies in the resolved domain when that domain denies', async () => {
      const res = await get('/tenant/files/f1', B);

      expect(res.status).to.eq(403);
      expect(res.body).to.have.nested.property('reason.code', 'no_access');
    });

    it('keeps the route domain when the resolver returns the fallback', async () => {
      const res = await get('/tenant/files/f1');

      expect(res.status).to.eq(403);
      expect(TenantResolver.fallbacks).to.deep.eq([BASE]);
    });

    it('answers 403 unknown_domain for a domain no live domain bears, without running the action', async () => {
      const res = await get('/tenant/files/f1', 'nope');

      expect(res.status).to.eq(403);
      expect(res.body).to.deep.include({ error: 'forbidden' });
      expect(res.body).to.have.nested.property('reason.code', 'unknown_domain');
      expect(res.body).to.not.have.property('allowed');
    });

    it('passes the domain of the route, else of the class, else root, as the fallback', async () => {
      await get('/tenant/files/f1', A);
      await get('/klass/files', A);
      await get('/tenant/anywhere', A);

      expect(TenantResolver.fallbacks).to.deep.eq([BASE, BASE, 'root']);
    });

    it('asks the resolver once per request', async () => {
      await get('/tenant/files/f1', A);

      expect(TenantResolver.fallbacks).to.have.length(1);
    });
  });

  describe('explain route', () => {
    let app: TestApp;
    let domains: TestDomain[];
    let unregisterSource: () => void;
    let unregisterResolver: () => void;

    before(async () => {
      unregisterSource = registerHeaderSource();
      unregisterResolver = registerTenantResolver();
      app = await startApp({ config: { 'authz.http.access': { domain: BASE }, 'authz.http.explainRoute': { enabled: true, permission: 'authz:explain' }, 'configuration.isProduction': false } });
      domains = [await createDomain(BASE, { permissions, model: { votes: denying } }), await createDomain(A, { permissions, model: { votes: permitting } })];
    });

    after(async () => {
      for (const d of domains ?? []) await d.dispose();
      await stopApp();
      unregisterResolver();
      unregisterSource();
    });

    const explain = (tenant?: string) => {
      const r = app.request().get('/authz/explain?principal=user:alice&permission=file:read&resource=file:f1').set('x-user', 'bob');
      return tenant === undefined ? r : r.set('x-tenant', tenant);
    };

    it('explains in the resolved domain, where the caller holds the explain permission', async () => {
      const res = await explain(A);

      expect(res.status).to.eq(200);
      expect(res.body).to.deep.include({ allowed: true, domain: A });
    });

    it('falls back to authz.http.access.domain', async () => {
      expect((await explain()).status).to.eq(403);
    });

    it('answers 403 unknown_domain for an unknown domain', async () => {
      const res = await explain('nope');

      expect(res.status).to.eq(403);
      expect(res.body).to.have.nested.property('reason.code', 'unknown_domain');
    });
  });

  describe('user access routes', () => {
    let app: TestApp;
    let domains: TestDomain[];
    let unregisterSource: () => void;
    let unregisterResolver: () => void;

    before(async () => {
      unregisterSource = registerHeaderSource();
      unregisterResolver = registerTenantResolver();
      app = await startApp({ controllers: [AccessController] });
      testHost.config().set(['authz', 'http', 'access'], { domain: BASE });
      domains = [await createDomain(BASE, { permissions, model: { votes: denying } }), await createDomain(A, { permissions, model: { votes: permitting } })];
    });

    after(async () => {
      testHost.config().unset(['authz', 'http', 'access']);
      for (const d of domains ?? []) await d.dispose();
      await stopApp();
      unregisterResolver();
      unregisterSource();
    });

    const check = (tenant?: string) => {
      const r = app.request().post('/user/access/checks').set('x-user', 'alice');
      return (tenant === undefined ? r : r.set('x-tenant', tenant)).send({ checks: [{ object: { type: 'file', id: 'f1' }, permission: 'file:read' }] });
    };

    it('answers the checks of the resolved domain', async () => {
      expect(resultsOf(await check(A))).to.deep.eq([true]);
      expect(resultsOf(await check())).to.deep.eq([false]);
    });

    it('summarizes the principal in the resolved domain', async () => {
      const res = await app.request().get('/user/access').set('x-user', 'alice').set('x-tenant', A);

      expect(res.status).to.eq(200);
      expect((res.body as { permissions: { name: string }[] }).permissions.map((p) => p.name)).to.include('file:read');
    });

    it('answers 403 unknown_domain for an unknown domain', async () => {
      const res = await check('nope');

      expect(res.status).to.eq(403);
      expect(res.body).to.have.nested.property('reason.code', 'unknown_domain');
    });
  });
});
