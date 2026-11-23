import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Controllers, Del, Get, HttpServer, Idempotent, Middleware, Ok, Param, Policy, Post, RouteMiddleware, ServerMiddleware } from '@spinajs/http';
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

let cacheKept: boolean | undefined;

const orders = { runs: 0, open: new Map<string, Set<string>>() };

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
    cacheKept = Reflect.has(ctx.storage, 'AuthzCache');
  }
}

/** The order is still open in the request's tenant: once cancelled there, a resend is refused. */
class OrderOpen extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public execute(req: Request): Promise<void> {
    const scope = req.storage.Tenant;
    const open = scope?.kind === 'tenant' ? orders.open.get(scope.tenant.id) : undefined;
    return open?.has(String(req.params.id)) ? Promise.resolve() : Promise.reject(new Forbidden('no such order'));
  }
}

/**
 * Stands in for authz-http's PrincipalMiddleware (Order 10): `x-user: <id>` is an authenticated user, alice is a member
 * of acme, erin of acme and globex, and authz's preload leaves a request cache; `x-session-tenant` stands in for the
 * session authn restored.
 */
class HeaderPrincipal extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 10;
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    const id = req.headers['x-user'];
    if (typeof id === 'string') {
      const tenants = new Map([
        ['alice', ['acme']],
        ['erin', ['acme', 'globex']],
      ]).get(id);
      Reflect.set(storage, 'Principal', { type: 'user', id, authenticated: true, source: 'test', attributes: { tenants: tenants ?? [] } });
      Reflect.set(storage, 'AuthzCache', new Map([['preloaded', true]]));
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

@BasePath('orders')
class OrderRoutes extends BaseController {
  @Post()
  @Idempotent()
  public place() {
    return new Ok({ tenant: currentTenant()?.id ?? null, run: ++orders.runs });
  }

  @Del(':id')
  @Idempotent()
  @Policy(OrderOpen)
  public cancel(@Param() id: string) {
    orders.open.get(currentTenant()?.id ?? '')?.delete(id);
    return new Ok({ tenant: currentTenant()?.id ?? null, run: ++orders.runs });
  }
}

const CONTROLLERS = [PathRoutes, HeaderRoutes, OpenRoutes];

// The test's own host is a base domain, so it names no tenant and the path, header and session decide.
const configuration = (trustProxy: string | undefined) =>
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
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        http: { port: 0, middlewares: [], AcceptHeaders: 1 | 2, trustProxy, routes: { middlewares: ['TenantMiddleware'] } },
        tenancy: { registry: 'MemoryTenantRegistry', http: { baseDomains: ['127.0.0.1', 'app.example.com'] } },
        idempotency: { store: 'MemoryIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' },
      };
    }
  };

interface Answer {
  status: number;
  headers: string[];
  replayed: boolean;
  body: Record<string, unknown>;
}

/** Boots the server in `before` and stops it in `after` of the enclosing describe. */
function useServer(trustProxy: string | undefined, controllers: readonly (typeof BaseController)[] = CONTROLLERS) {
  const server: { port: number; registry?: MemoryTenantRegistry } = { port: 0 };
  let app: TestApp | undefined;

  before(async () => {
    app = await createTestApp({
      configuration: configuration(trustProxy),
      register: (c) => {
        for (const type of controllers) c.register(type).as(BaseController);
        c.register(HeaderPrincipal).as(ServerMiddleware);
      },
      resolve: [fsService, Controllers],
      bootTimeout: 50000,
    });
    server.registry = await seedTenants();
    const http = await app.resolve(HttpServer);
    await http.start();
    server.port = (http.Server.address() as AddressInfo).port;
  });

  after(async () => {
    await DI.get(HttpServer)?.stop();
    await app?.dispose();
  });

  beforeEach(() => {
    policySaw.tenant = null;
    sourceSeen = undefined;
    cacheKept = undefined;
  });

  // node:http rather than fetch: the Host header is set by hand.
  const send = (method: string, path: string, headers: Record<string, string> = {}): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = request({ method, host: '127.0.0.1', port: server.port, path, headers: { accept: 'application/json', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: Object.keys(res.headers).sort(), replayed: res.headers['idempotent-replayed'] === 'true', body: JSON.parse(text) as Record<string, unknown> }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  const get = (path: string, headers: Record<string, string> = {}) => send('GET', path, headers);

  return { server, get, send };
}

describe('tenant scope of an http request', function () {
  this.timeout(60000);

  const { server, get } = useServer('loopback');

  it('sets the scope before the policy gate and for the action, without the authz cache loaded before it', async () => {
    const res = await get('/t/acme-inc/who', { 'x-user': 'alice' });

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ tenant: 'acme', policySaw: 'acme' });
    expect([sourceSeen?.host, sourceSeen?.params, sourceSeen?.principal?.id]).to.deep.eq(['127.0.0.1', { tenant: 'acme-inc' }, 'alice']);
    expect(cacheKept).to.eq(false);
  });

  it('honours the header for a member and for nobody else', async () => {
    expect((await get('/api/who', { 'x-user': 'alice', 'x-tenant': 'acme' })).body).to.deep.eq({ tenant: 'acme' });
    expect((await get('/api/who', { 'x-user': 'bob', 'x-tenant': 'acme' })).status).to.eq(404);
    expect((await get('/api/who', { 'x-tenant': 'acme' })).status).to.eq(404);
  });

  it('answers an unknown, a forbidden, a missing and a suspended tenant alike, before the policy runs', async () => {
    const answers = [
      await get('/api/who', { 'x-user': 'alice', 'x-tenant': 'nobody' }),
      await get('/api/who', { 'x-user': 'bob', 'x-tenant': 'acme' }),
      await get('/api/who', { 'x-tenant': 'acme' }),
      await get('/api/who', { 'x-user': 'alice', 'x-tenant': 'frozen' }),
    ];
    const suspendedOnPath = await get('/t/frozen/who', { 'x-user': 'alice' });

    expect(answers[0].status).to.eq(404);
    expect(answers[0].body).to.include({ status: 404, code: 'tenant.unavailable', detail: 'Not found' });
    for (const answer of answers.slice(1)) {
      expect([answer.status, answer.headers, answer.body]).to.deep.eq([answers[0].status, answers[0].headers, answers[0].body]);
    }
    expect(suspendedOnPath.body).to.include({ status: 404, code: 'tenant.unavailable', detail: 'Not found' });
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
    const registry = server.registry;
    if (!registry) throw new Error('the server did not boot');
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

describe('Idempotency-Key of an http request in a tenant', function () {
  this.timeout(60000);

  // The only server with an @Idempotent route: @spinajs/idempotency, which it imports on registration, registers its
  // stores at import, and a root test app forgets what was registered during its life.
  const { server, send } = useServer('loopback', [...CONTROLLERS, OrderRoutes]);
  const inTenant = (tenant: string, key: string) => ({ 'x-user': 'erin', 'x-tenant': tenant, 'idempotency-key': key });

  before(() => {
    server.registry?.add({ id: 'globex', slug: 'globex', domains: ['shop.globex.example'] });
  });

  beforeEach(() => {
    orders.runs = 0;
    orders.open = new Map([
      ['acme', new Set(['1'])],
      ['globex', new Set(['1', '2'])],
    ]);
  });

  it("runs one principal's key once in each tenant, and replays each tenant its own reply", async () => {
    const acme = await send('POST', '/orders/place', inTenant('acme', 'order-1'));
    const globex = await send('POST', '/orders/place', inTenant('globex', 'order-1'));
    const acmeAgain = await send('POST', '/orders/place', inTenant('acme', 'order-1'));
    const globexAgain = await send('POST', '/orders/place', inTenant('globex', 'order-1'));

    expect([acme.status, acme.replayed, acme.body]).to.deep.eq([200, false, { tenant: 'acme', run: 1 }]);
    expect([globex.status, globex.replayed, globex.body]).to.deep.eq([200, false, { tenant: 'globex', run: 2 }]);
    expect([acmeAgain.replayed, acmeAgain.body]).to.deep.eq([true, { tenant: 'acme', run: 1 }]);
    expect([globexAgain.replayed, globexAgain.body]).to.deep.eq([true, { tenant: 'globex', run: 2 }]);
  });

  it('runs an anonymous key once in each tenant', async () => {
    const key = randomUUID();
    const acme = await send('POST', '/orders/place', { host: 'shop.acme.example', 'idempotency-key': key });
    const globex = await send('POST', '/orders/place', { host: 'shop.globex.example', 'idempotency-key': key });
    const globexAgain = await send('POST', '/orders/place', { host: 'shop.globex.example', 'idempotency-key': key });

    expect([acme.body, globex.replayed, globex.body]).to.deep.eq([{ tenant: 'acme', run: 1 }, false, { tenant: 'globex', run: 2 }]);
    expect([globexAgain.replayed, globexAgain.body]).to.deep.eq([true, { tenant: 'globex', run: 2 }]);
  });

  it("never replays another tenant's reply before the policies, and replays its own past a refusing policy", async () => {
    const acme = await send('DELETE', '/orders/1', inTenant('acme', 'cancel-1'));
    const globex = await send('DELETE', '/orders/1', inTenant('globex', 'cancel-1'));
    const acmeAgain = await send('DELETE', '/orders/1', inTenant('acme', 'cancel-1'));

    expect(acme.body).to.deep.eq({ tenant: 'acme', run: 1 });
    expect([globex.status, globex.replayed, globex.body]).to.deep.eq([200, false, { tenant: 'globex', run: 2 }]);
    expect([acmeAgain.status, acmeAgain.replayed, acmeAgain.body]).to.deep.eq([200, true, { tenant: 'acme', run: 1 }]);
  });

  it('does not refuse as key reuse a key used in another tenant on another request', async () => {
    await send('DELETE', '/orders/1', inTenant('acme', 'reuse-1'));
    const globex = await send('DELETE', '/orders/2', inTenant('globex', 'reuse-1'));

    expect([globex.status, globex.body]).to.deep.eq([200, { tenant: 'globex', run: 2 }]);
  });
});

describe('tenant scope of an http request without a trusted proxy', function () {
  this.timeout(60000);

  const { get } = useServer(undefined);

  it('ignores X-Forwarded-Host and takes the host from Host', async () => {
    expect((await get('/api/who', { 'x-forwarded-host': 'shop.acme.example' })).status).to.eq(404);

    expect((await get('/t/acme-inc/who', { 'x-forwarded-host': 'shop.acme.example' })).body).to.deep.eq({ tenant: 'acme', policySaw: 'acme' });
    expect(sourceSeen?.host).to.eq('127.0.0.1');

    expect((await get('/api/who', { host: 'shop.acme.example', 'x-forwarded-host': '127.0.0.1' })).body).to.deep.eq({ tenant: 'acme' });
    expect(sourceSeen?.host).to.eq('shop.acme.example');
  });
});
