import 'mocha';
import { expect } from 'chai';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePath, BasePolicy, Controllers, Get, HttpServer, Middleware, Ok, Policy, RouteMiddleware, ServerMiddleware } from '@spinajs/http';
import type { IMiddlewareContext, MiddlewareStage, Request } from '@spinajs/http';
import { currentTenant, tenantScope } from '@spinajs/tenancy';
import type { MemoryTenantRegistry } from '@spinajs/tenancy';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { AllTenants, NoTenant, httpSource } from '../src/index.js';
import type { TenantRequestSource } from '../src/index.js';
import { seedTenants } from './support/source.js';

const policySaw: { tenant: string | null } = { tenant: null };

let sourceSeen: TenantRequestSource | undefined;

class SeesTenant extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public execute(req: Request): Promise<void> {
    const scope = req.storage.Tenant;
    policySaw.tenant = scope?.kind === 'tenant' ? scope.tenant.id : null;
    return Promise.resolve();
  }
}

/** Records what the resolvers read from a real request; mounted after the global TenantMiddleware. */
class SourceProbe extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  public onBefore(ctx: IMiddlewareContext): void {
    sourceSeen = httpSource(ctx);
  }
}

/**
 * Stands in for authz-http's PrincipalMiddleware (Order 10): `x-user: <id>` is an authenticated user, alice is a member
 * of acme; `x-session-tenant` stands in for the session authn restored.
 */
class HeaderPrincipal extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 10;
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    const id = req.headers['x-user'];
    if (typeof id === 'string') {
      Reflect.set(storage, 'Principal', { type: 'user', id, authenticated: true, source: 'test', attributes: { tenants: id === 'alice' ? ['acme'] : [] } });
    }
    const sessionTenant = req.headers['x-session-tenant'];
    if (typeof sessionTenant === 'string') {
      Reflect.set(storage, 'AuthnSession', { data: new Map([['tenant', sessionTenant]]) });
    }
  }
}

@BasePath('t')
class PathRoutes extends BaseController {
  @Get(':tenant/who')
  @Policy(SeesTenant)
  @Middleware(SourceProbe)
  public who() {
    return new Ok({ tenant: currentTenant()?.id ?? null, policySaw: policySaw.tenant });
  }
}

@BasePath('api')
class HeaderRoutes extends BaseController {
  @Get('who')
  @Middleware(SourceProbe)
  public who() {
    return new Ok({ tenant: currentTenant()?.id ?? null });
  }
}

@BasePath('open')
class OpenRoutes extends BaseController {
  @NoTenant()
  @Get('health')
  public health() {
    return new Ok({ scope: tenantScope() ?? null });
  }

  @AllTenants('status page')
  @Get('all')
  public all() {
    return new Ok({ scope: tenantScope() ?? null });
  }
}

const CONTROLLERS = [PathRoutes, HeaderRoutes, OpenRoutes];

class TenancyHttpConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const provider = (name: string) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      intl: { locales: ['en'], defaultLocale: 'en' },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      http: { port: 0, middlewares: [], AcceptHeaders: 1 | 2, trustProxy: 'loopback', routes: { middlewares: ['TenantMiddleware'] } },
      // The test's own host is a base domain, so it names no tenant and the path, header and session decide.
      tenancy: { registry: 'MemoryTenantRegistry', http: { baseDomains: ['127.0.0.1', 'app.example.com'] } },
    };
  }
}

describe('tenant scope of an http request', function () {
  this.timeout(60000);

  let app: TestApp;
  let port: number;
  let registry: MemoryTenantRegistry;

  // node:http rather than fetch: the Host header is set by hand.
  const get = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { accept: 'application/json', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end();
    });

  before(async () => {
    app = await createTestApp({
      configuration: TenancyHttpConfiguration,
      register: (c) => {
        for (const type of CONTROLLERS) c.register(type).as(BaseController);
        c.register(HeaderPrincipal).as(ServerMiddleware);
      },
      resolve: [fsService, Controllers],
      bootTimeout: 50000,
    });
    registry = await seedTenants();
    const server = await app.resolve(HttpServer);
    await server.start();
    port = (server.Server.address() as AddressInfo).port;
  });

  after(async () => {
    await DI.get(HttpServer)?.stop();
    await app?.dispose();
  });

  beforeEach(() => {
    policySaw.tenant = null;
    sourceSeen = undefined;
  });

  it('sets the scope before the policy gate and for the action', async () => {
    const res = await get('/t/acme-inc/who', { 'x-user': 'alice' });

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ tenant: 'acme', policySaw: 'acme' });
    expect([sourceSeen?.host, sourceSeen?.params, sourceSeen?.principal?.id]).to.deep.eq(['127.0.0.1', { tenant: 'acme-inc' }, 'alice']);
  });

  it('honours the header for a member and for nobody else', async () => {
    expect((await get('/api/who', { 'x-user': 'alice', 'x-tenant': 'acme' })).body).to.deep.eq({ tenant: 'acme' });
    expect((await get('/api/who', { 'x-user': 'bob', 'x-tenant': 'acme' })).status).to.eq(404);
    expect((await get('/api/who', { 'x-tenant': 'acme' })).status).to.eq(404);
  });

  it('answers 404 with the code tenant.unavailable for an unknown and for a suspended tenant, before the policy runs', async () => {
    const bodies: Record<string, unknown>[] = [];
    for (const slug of ['nobody', 'frozen']) {
      const res = await get(`/t/${slug}/who`, { 'x-user': 'alice' });

      expect(res.status).to.eq(404);
      expect(res.body).to.include({ status: 404, code: 'tenant.unavailable', detail: 'Not found' });
      // `instance` is the request's own path; nothing else may differ.
      const { instance: _path, ...body } = res.body;
      bodies.push(body);
    }
    expect(bodies[0]).to.deep.eq(bodies[1]);
    expect(policySaw.tenant).to.eq(null);
  });

  it('runs a @NoTenant route with no scope and an @AllTenants route across tenants', async () => {
    expect((await get('/open/health', { 'x-user': 'alice', 'x-tenant': 'acme' })).body).to.deep.eq({ scope: null });
    expect((await get('/open/all')).body).to.deep.eq({ scope: { kind: 'all', reason: 'status page' } });
  });

  it('takes the host from X-Forwarded-Host of a trusted proxy, else from Host', async () => {
    expect((await get('/api/who', { 'x-forwarded-host': 'shop.acme.example' })).body).to.deep.eq({ tenant: 'acme' });
    expect(sourceSeen?.host).to.eq('shop.acme.example');

    expect((await get('/api/who', { host: 'Shop.Acme.Example:8080' })).body).to.deep.eq({ tenant: 'acme' });
    expect(sourceSeen?.host).to.eq('shop.acme.example');

    expect((await get('/api/who', { host: 'shop.acme.example', 'x-forwarded-host': '127.0.0.1' })).status).to.eq(404);
  });

  it('reads the tenant from the session authn restored', async () => {
    expect((await get('/api/who', { 'x-user': 'alice', 'x-session-tenant': 'acme' })).body).to.deep.eq({ tenant: 'acme' });
    expect(sourceSeen?.session?.get('tenant')).to.eq('acme');
  });

  it('refuses the request when the registry fails, and the action does not run', async () => {
    registry.get = () => Promise.reject(new Error('registry down'));
    try {
      const res = await get('/api/who', { 'x-user': 'alice', 'x-tenant': 'acme' });

      expect(res.status).to.eq(500);
      expect(res.body).to.not.have.property('tenant');
      expect(sourceSeen).to.eq(undefined);
    } finally {
      Reflect.deleteProperty(registry, 'get');
    }
  });
});
