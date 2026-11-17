import 'mocha';
import { expect } from 'chai';
import type { IMiddlewareContext } from '@spinajs/http';
import { TenantUnavailable } from '@spinajs/tenancy';
import type { MemoryTenantRegistry } from '@spinajs/tenancy';
import type { TestApp } from '@spinajs/testing';
import { TenantMiddleware, TenantRefused } from '../src/index.js';
import type { TenantRouteDeclaration } from '../src/index.js';
import { seedTenants, tenancyHttpApp, user } from './support/source.js';

interface FakeRequest {
  host?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  storage?: Record<string, unknown>;
}

const context = (over: FakeRequest = {}): IMiddlewareContext => ({ req: { hostname: over.host ?? 'localhost', headers: over.headers ?? {}, params: over.params ?? {} }, res: {}, storage: over.storage ?? {} }) as unknown as IMiddlewareContext;

const refusalOf = (work: Promise<void>): Promise<TenantRefused> =>
  work.then(
    () => {
      throw new Error('the request was let through');
    },
    (err: unknown) => {
      if (err instanceof TenantRefused) return err;
      throw err;
    },
  );

const alice = user('alice', { tenants: ['acme', 'frozen'] });
const bob = user('bob');

describe('TenantMiddleware', () => {
  let app: TestApp;

  const mount = (declaration?: TenantRouteDeclaration): Promise<TenantMiddleware> => app.container.resolve(TenantMiddleware, declaration ? [declaration] : []);

  afterEach(async () => {
    await app?.dispose();
  });

  describe('where a tenant is required', () => {
    let registry: MemoryTenantRegistry;

    beforeEach(async () => {
      app = await tenancyHttpApp();
      registry = await seedTenants();
    });

    it('runs before the policy gate', async () => {
      expect((await mount()).Stage).to.eq('beforePolicy');
    });

    it('writes the scope of the tenant an authenticated member names in the header', async () => {
      const ctx = context({ headers: { 'x-tenant': 'acme' }, storage: { Principal: alice } });

      await (await mount()).onBefore(ctx);

      expect(ctx.storage.Tenant).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
    });

    it('takes the principal authn left when authz established none', async () => {
      const ctx = context({ headers: { 'x-tenant': 'acme' }, storage: { AuthnPrincipal: alice } });

      await (await mount()).onBefore(ctx);

      expect(ctx.storage.Tenant).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
    });

    it('admits an anonymous request on a trusted source', async () => {
      const ctx = context({ params: { tenant: 'acme-inc' } });

      await (await mount()).onBefore(ctx);

      expect(ctx.storage.Tenant).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
    });

    it('answers the same 404 for an unknown, a suspended, a forbidden and a missing tenant, and writes no scope', async () => {
      const middleware = await mount();
      const refused = [
        context({ headers: { 'x-tenant': 'nobody' }, storage: { Principal: alice } }),
        context({ headers: { 'x-tenant': 'frozen' }, storage: { Principal: alice } }),
        context({ headers: { 'x-tenant': 'acme' }, storage: { Principal: bob } }),
        context({ headers: { 'x-tenant': 'acme' } }),
        context(),
      ];

      const answers: [number, string, string][] = [];
      const reasons: unknown[] = [];
      for (const ctx of refused) {
        const refusal = await refusalOf(middleware.onBefore(ctx));
        answers.push([refusal.status, refusal.code, refusal.message]);
        reasons.push(refusal.inner instanceof TenantUnavailable ? refusal.inner.reason : refusal.inner);
        expect(ctx.storage).to.not.have.property('Tenant');
      }

      expect(answers).to.deep.eq(new Array(5).fill([404, 'tenant.unavailable', 'Not found']));
      expect(reasons).to.deep.eq(['unknown', 'inactive', 'forbidden', 'unknown', 'unknown']);
    });

    it('lets a registry failure through as itself, never as a request without a tenant', async () => {
      const failure = new Error('registry down');
      registry.get = () => Promise.reject(failure);
      const ctx = context({ headers: { 'x-tenant': 'acme' }, storage: { Principal: alice } });

      const err = await (await mount()).onBefore(ctx).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(err).to.eq(failure);
      expect(ctx.storage).to.not.have.property('Tenant');
    });
  });

  it('answers 403 when tenancy.http.unknownTenant says so', async () => {
    app = await tenancyHttpApp({ http: { unknownTenant: 403 } });

    const refusal = await refusalOf((await mount()).onBefore(context()));

    expect([refusal.status, refusal.code, refusal.message]).to.deep.eq([403, 'tenant.unavailable', 'Forbidden']);
  });

  it('removes any scope where the route declares none', async () => {
    app = await tenancyHttpApp();
    const ctx = context({ headers: { 'x-tenant': 'acme' }, storage: { Principal: alice, Tenant: { kind: 'tenant', tenant: { id: 'acme' } } } });

    await (await mount({ tenancy: 'none' })).onBefore(ctx);

    expect(ctx.storage).to.not.have.property('Tenant');
  });

  it('writes the cross-tenant scope with its reason where the route declares it', async () => {
    app = await tenancyHttpApp();
    const ctx = context();

    await (await mount({ tenancy: 'all', reason: 'status page' })).onBefore(ctx);

    expect(ctx.storage.Tenant).to.deep.eq({ kind: 'all', reason: 'status page' });
  });
});
