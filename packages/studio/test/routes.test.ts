import 'mocha';
import { expect } from 'chai';
import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { DI, Singleton } from '@spinajs/di';
import { Access, AllowAnonymous } from '@spinajs/authz-http';
import { BaseController, BasePath, BasePolicy, Get, Ok, Param, Policy, Post, Public } from '@spinajs/http';
import type { ControllerEntry, RouteEntry } from '@spinajs/manifest';
import { sourceRef, testManifest } from '@spinajs/testing';

import type { RoleGraphLike } from '../src/authz/roles.js';
import { TraceStore } from '../src/buffers/trace-store.js';
import type { RouteInfo, StudioGraph, StudioRoutes, StudioSpan } from '../src/contracts/index.js';
import { MAX_GRAPH_LIMIT, viewOf } from '../src/graph/graph.js';
import { StudioSpanProcessor } from '../src/processor.js';
import { MAX_ACCESS_MAP_EDGES, accessMap, joinRoutes, manifestRoutes, routeKey, routeStats, telemetryStats } from '../src/routes/routes.js';
import { RoutesService } from '../src/routes/service.js';
import { STUDIO_CONFIGURATION_SCHEMA } from '../src/schema.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { RBAC_SECRETS, rbacModel } from './support/authz.js';
import { ROOT_PERMISSIONS } from './support/config.js';
import { registerHeaderSource } from './support/principals.js';
import { fakeSpan } from './support/spans.js';

const SECRET_OPTION = 'SECRET-policy-option';
const SECRET_REASON = 'SECRET-public-reason';
const SECRET_CLASS_REASON = 'SECRET-class-reason';

class StudioRoutesOpenPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    // Admits every request.
  }
}

@BasePath('orders')
class StudioRoutesProbeController extends BaseController {
  @Get('/')
  @Access('order:read')
  public list() {
    return new Ok([]);
  }

  @Get(':id')
  @AllowAnonymous()
  public get(@Param() id: string) {
    return new Ok({ id });
  }

  @Post('/')
  public create() {
    return new Ok({});
  }

  @Get('probe/health')
  @Public('liveness probe')
  public health() {
    return new Ok({});
  }

  @Get('probe/ready')
  @Public(SECRET_REASON)
  @Policy(StudioRoutesOpenPolicy, SECRET_OPTION)
  public ready() {
    return new Ok({});
  }
}

@BasePath('pub')
@Public(SECRET_CLASS_REASON)
class StudioRoutesPublicController extends BaseController {
  @Get('ping')
  public ping() {
    return new Ok({});
  }
}

@BasePath('anon')
@AllowAnonymous()
class StudioRoutesAnonController extends BaseController {
  @Get('ping')
  public ping() {
    return new Ok({});
  }
}

// Found by DI under this class name, as @spinajs/telemetry's store is.
@Singleton()
class TelemetryStore {
  public readonly RouteStats = { toJSON: () => ({ truncated: false, routes: [{ method: 'POST', route: '/orders', stats: { responses: 4, errors: 1 } }] }) };
}

class LatencyProbe extends RoutesService {
  public routesVersion = 0;

  public constructor(traces: TraceStore) {
    super();
    this.Traces = traces;
  }

  public latencyOf(runtime: readonly RouteInfo[]) {
    return this.latency(runtime);
  }

  protected index() {
    return { version: this.routesVersion, all: () => [] };
  }
}

const singleRole = (permission: string): RoleGraphLike => ({ names: ['r'], ladders: [], get: () => ({ def: { extends: [], grants: [{ permission }] }, assignable: true }) });

const span = (route: string, durationMs: number, status: StudioSpan['status'] = 'unset', kind: StudioSpan['kind'] = 'server'): StudioSpan => ({
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  name: `GET ${route}`,
  kind,
  startUnixNano: '0',
  durationNs: String(durationMs * 1_000_000),
  status,
  attributes: { 'http.route': route, 'http.request.method': 'GET' },
  events: [],
  links: [],
  scope: '@spinajs',
});

const entry = (partial: Partial<RouteEntry>): RouteEntry => ({ method: 'get', path: '/', handler: 'list', fullPath: '/orders', params: [], returnType: { text: 'unknown' }, policies: [], middlewares: [], source: sourceRef('src/Orders.ts'), ...partial });

const info = (method: string, path: string, extra: Partial<RouteInfo> = {}): RouteInfo => ({ method, path, controller: 'C', action: 'a', policies: [], access: [], controllerPolicies: [], controllerAccess: [], allowAnonymous: false, unguarded: true, ...extra });

const longest = (value: unknown): number => {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value)) return Math.max(0, ...value.map(longest));
  if (typeof value === 'object' && value !== null) return Math.max(0, ...Object.entries(value).map(([k, v]) => Math.max(Buffer.byteLength(k), longest(v))));
  return 0;
};

describe('route stats and the manifest source', () => {
  it('computes count, error rate and nearest-rank percentiles per method and route', () => {
    const spans = [...Array.from({ length: 19 }, (_, i) => span('/a', i + 1)), span('/a', 100, 'error')];
    const stats = routeStats(spans).get(routeKey('GET', '/a'));
    expect(stats).to.deep.eq({ count: 20, errorRate: 0.05, p50Ms: 10, p95Ms: 19 });
  });

  it('counts server spans only, keyed by their route template', () => {
    const stats = routeStats([span('/orders/:id', 5), span('/orders/:id', 7), span('/orders/:id', 9, 'unset', 'internal')]);
    expect([...stats.keys()]).to.deep.eq(['GET /orders/:id']);
    expect(stats.get('GET /orders/:id')?.count).to.eq(2);
  });

  it('reads manifest routes with upper-case methods, the global prefix and class scopes', () => {
    const controller: ControllerEntry = { id: 'app:Orders', className: 'Orders', basePath: 'orders', policies: [], middlewares: [], access: ['order:admin'], routes: [entry({ access: ['order:read'] }), entry({ method: 'post', handler: 'create' })], source: sourceRef('src/Orders.ts') };
    // The prefix as http.controllers.route.prefix holds it: no leading slash (withRoutePrefix adds one).
    const routes = manifestRoutes(testManifest({ controllers: [controller] }), 'api');
    expect(routes.map((r) => routeKey(r.method, r.path))).to.deep.eq(['GET /api/orders', 'POST /api/orders']);
    expect(routes[0]).to.deep.include({ controller: 'Orders', action: 'list', access: ['order:read'], controllerAccess: ['order:admin'], unguarded: false });
  });

  it('reads a file route as GET and a @Public route as anonymous', () => {
    const files = (partial: Partial<RouteEntry>) => entry({ fullPath: '/files', source: sourceRef('src/Files.ts'), ...partial });
    const controller: ControllerEntry = { id: 'app:Files', className: 'Files', basePath: 'files', policies: [], middlewares: [], routes: [files({ method: 'file', handler: 'download' }), files({ method: 'post', handler: 'hook', public: 'webhook' })], source: sourceRef('src/Files.ts') };
    const routes = manifestRoutes(testManifest({ controllers: [controller] }), undefined);
    expect(routes.map((r) => [r.method, r.allowAnonymous, r.unguarded])).to.deep.eq([['GET', false, true], ['POST', true, false]]);
  });

  it('reads a class-level @Public or @AllowAnonymous of the manifest as anonymous', () => {
    const controller = (className: string, scope: Partial<ControllerEntry>): ControllerEntry => ({ id: `app:${className}`, className, basePath: className, policies: [], middlewares: [], routes: [entry({ fullPath: `/${className}` })], source: sourceRef('src/C.ts'), ...scope });
    const routes = manifestRoutes(testManifest({ controllers: [controller('pub', { public: 'x' }), controller('anon', { allowAnonymous: true })] }), undefined);
    expect(routes.map((r) => [r.allowAnonymous, r.unguarded])).to.deep.eq([[true, false], [true, false]]);
  });

  it('sends policy names, never their options or a @Public reason, and cuts every name at 2 KiB', () => {
    const long = 'x'.repeat(5000);
    const controller: ControllerEntry = {
      id: 'app:Long',
      className: long,
      basePath: 'long',
      policies: [[{ type: long, options: [SECRET_OPTION] }]],
      middlewares: [],
      routes: [entry({ handler: long, fullPath: `/${long}`, access: [long], public: SECRET_REASON, source: sourceRef(long, long) })],
      source: sourceRef('src/Long.ts'),
    };
    const routes = manifestRoutes(testManifest({ controllers: [controller] }), undefined);
    const text = JSON.stringify(routes);
    expect(text).to.not.include(SECRET_OPTION);
    expect(text).to.not.include(SECRET_REASON);
    expect(longest(routes)).to.be.lessThan(2100);
  });

  it('joins the manifest source on the served path and latency on the mounted path', () => {
    const source = sourceRef('src/Users.ts');
    const runtime = [info('GET', '/users/'), info('POST', '/users')];
    const data = joinRoutes(runtime, [info('GET', '/users', { source })], new Map([['GET /users/', { count: 1, errorRate: 0, p50Ms: 1, p95Ms: 1 }]]), new Map([['POST /users', { count: 3, errorRate: 0 }]]));
    expect(data[0]).to.deep.include({ source, stats: { count: 1, errorRate: 0, p50Ms: 1, p95Ms: 1 } });
    expect(data[1]).to.deep.include({ telemetry: { count: 3, errorRate: 0 } });
    expect(data[1]).to.not.have.property('source');
  });

  it('stops the access map at its edge budget and marks it truncated', () => {
    const perms = Array.from({ length: 101 }, (_, i) => `p:${i}`);
    const routes = Array.from({ length: 200 }, (_, i) => info('GET', `/r${i}`, { access: perms, unguarded: false }));
    const g = accessMap(routes, undefined);
    expect(g.edges.length).to.be.at.most(MAX_ACCESS_MAP_EDGES);
    expect(g.truncated).to.eq(true);
    expect(accessMap(routes.slice(0, 2), undefined).truncated).to.eq(false);
  });

  it('keeps the roles of the routes it shows when the map is cut by nodes or by edges', () => {
    const routes = Array.from({ length: 21_000 }, (_, i) => info('GET', `/r${i}`, { access: ['p:0'], unguarded: false }));
    const g = viewOf(accessMap(routes, singleRole('p:0')), { limit: MAX_GRAPH_LIMIT });
    expect(g.truncated).to.eq(true);
    expect(g.nodes.map((n) => n.id)).to.include('role:r');
    expect(g.edges.some((e) => e.source === 'role:r' && e.kind === 'grants' && e.target === 'perm:p:0')).to.eq(true);
  });

  it('reads telemetry route counts by shape, and nothing from anything else', () => {
    expect(telemetryStats(new TelemetryStore()).get('POST /orders')).to.deep.eq({ count: 4, errorRate: 0.25 });
    expect(telemetryStats({ RouteStats: {} }).size).to.eq(0);
  });

  it('caches latency for mounted routes only, until the mounted routes change', () => {
    const traces = new TraceStore({ traces: 10, spansPerTrace: 10, maxBytes: 1_000_000, capture: { redact: new Set(), captureBindings: false }, basePath: '/_studio' });
    const processor = new StudioSpanProcessor(() => traces);
    const s = fakeSpan({ trace: 'l', kind: SpanKind.SERVER, attributes: { 'http.route': '/later', 'http.request.method': 'GET' } });
    processor.onStart(s, ROOT_CONTEXT);
    processor.onEnd(s);
    const probe = new LatencyProbe(traces);
    const later = [info('GET', '/later')];

    expect(probe.latencyOf([]).size).to.eq(0);
    probe.routesVersion++;
    expect(probe.latencyOf(later).get('GET /later')?.count).to.eq(1);
  });
});

describe('studio.path', () => {
  it('refuses a mount at the root', () => {
    // As Ajv reads `pattern`: unanchored.
    const accepted = (path: string) => path.match(STUDIO_CONFIGURATION_SCHEMA.properties.path.pattern) !== null;
    expect(['/', '//', ' / '].filter(accepted)).to.deep.eq([]);
    expect(['/_studio', '_studio', 'admin/studio'].every(accepted)).to.eq(true);
  });
});

describe('GET /_studio/api/routes', function () {
  this.timeout(60000);

  let app: TestApp;
  let unregister: () => void;
  const get = (path: string, user = 'bob') => app.request().get(path).set('Accept', 'application/json').set('x-user', user);
  const find = (routes: RouteInfo[], method: string, path: string) => routes.find((r) => r.method === method && r.path === path);

  before(async () => {
    unregister = registerHeaderSource();
    for (const c of [StudioRoutesProbeController, StudioRoutesPublicController, StudioRoutesAnonController]) DI.register(c).as(BaseController);
    app = await startApp({
      models: [rbacModel()],
      config: {
        'authz.permissions': { ...ROOT_PERMISSIONS, 'order:read': { types: ['order'] }, 'order:write': {} },
        'authz.combine.default.models': ['m1', 'rbac'],
        'authz.http.unguardedRoutes': 'warn',
      },
    });
    await app.request().get('/orders/7');
    await app.request().get('/orders/8');
    DI.resolve(TelemetryStore);
  });

  after(async () => {
    await stopApp();
    for (const c of [StudioRoutesProbeController, StudioRoutesPublicController, StudioRoutesAnonController]) DI.unregister(c);
    DI.uncache(TelemetryStore);
    unregister();
  });

  it('lists the mounted routes with policies, access and the unguarded flag, Studio left out', async () => {
    const body = (await get('/_studio/api/routes')).body as StudioRoutes;
    expect(body.source).to.eq('runtime');
    expect(find(body.data, 'GET', '/orders')).to.deep.include({ controller: 'StudioRoutesProbeController', action: 'list', access: ['order:read'], unguarded: false });
    expect(find(body.data, 'GET', '/orders/:id')).to.deep.include({ allowAnonymous: true, unguarded: false });
    expect(find(body.data, 'POST', '/orders')?.unguarded).to.eq(true);
    expect(find(body.data, 'GET', '/orders/probe/health')).to.deep.include({ allowAnonymous: true, unguarded: false });
    expect(find(body.data, 'GET', '/pub/ping')).to.deep.include({ allowAnonymous: true, unguarded: false });
    expect(find(body.data, 'GET', '/anon/ping')).to.deep.include({ allowAnonymous: true, unguarded: false });
    expect(body.data.some((r) => r.path.startsWith('/_studio'))).to.eq(false);
  });

  it('sends policy names and permissions, never policy options or a @Public reason', async () => {
    const res = await get('/_studio/api/routes');
    expect(find((res.body as StudioRoutes).data, 'GET', '/orders/probe/ready')?.policies).to.deep.eq([['StudioRoutesOpenPolicy']]);
    expect(find((res.body as StudioRoutes).data, 'GET', '/orders')?.policies).to.deep.eq([['AccessPolicy']]);
    expect(res.text).to.not.include(SECRET_OPTION);
    expect(res.text).to.not.include(SECRET_REASON);
    expect(res.text).to.not.include(SECRET_CLASS_REASON);
  });

  it('joins the counts of a resolved TelemetryStore', async () => {
    const body = (await get('/_studio/api/routes')).body as StudioRoutes;
    expect(find(body.data, 'POST', '/orders')?.telemetry).to.deep.eq({ count: 4, errorRate: 0.25 });
  });

  it('joins latency from the trace buffer on method and route template', async () => {
    const body = (await get('/_studio/api/routes')).body as StudioRoutes;
    expect(find(body.data, 'GET', '/orders/:id')?.stats?.count).to.eq(2);
    expect(find(body.data, 'POST', '/orders')).to.not.have.property('stats');
    // The cached latency is computed again once the trace buffer changed.
    await app.request().get('/orders/9');
    const again = (await get('/_studio/api/routes')).body as StudioRoutes;
    expect(find(again.data, 'GET', '/orders/:id')?.stats?.count).to.eq(3);
  });

  it('pages the routes by limit and cursor, every route without them', async () => {
    const all = (await get('/_studio/api/routes')).body as StudioRoutes;
    expect(all.total).to.eq(all.data.length);
    expect(all).to.not.have.property('cursor');
    const first = (await get('/_studio/api/routes?limit=1')).body as StudioRoutes;
    expect(first.data).to.have.length(1);
    expect(first.cursor).to.eq('1');
    const second = (await get(`/_studio/api/routes?limit=1&cursor=${first.cursor ?? ''}`)).body as StudioRoutes;
    expect(second.data[0]).to.deep.eq(all.data[1]);
  });

  it('answers the access map with unguarded routes marked and the RBAC roles granting a required permission', async () => {
    const res = await get('/_studio/api/authz/access-map');
    const g = res.body as StudioGraph;
    for (const secret of [...RBAC_SECRETS, SECRET_OPTION, SECRET_REASON]) expect(res.text).to.not.include(secret);
    expect(g.edges.some((e) => e.source === 'route:GET /orders' && e.kind === 'requires' && e.target === 'perm:order:read')).to.eq(true);
    expect(g.nodes.find((n) => n.id === 'route:POST /orders')?.attributes.unguarded).to.eq(true);
    expect(g.edges.filter((e) => e.kind === 'grants' && e.target === 'perm:order:read').map((e) => e.source)).to.have.members(['role:viewer', 'role:editor', 'role:member']);
    // order:write is granted but no route requires it.
    expect(g.nodes.some((n) => n.id === 'perm:order:write' || n.id === 'role:owner')).to.eq(false);
    const limited = (await get('/_studio/api/authz/access-map?limit=3')).body as StudioGraph;
    expect(limited.nodes.map((n) => n.id)).to.deep.eq(['route:GET /orders', 'perm:order:read', 'role:viewer']);
    expect(limited.edges.some((e) => e.source === 'role:viewer' && e.kind === 'grants' && e.target === 'perm:order:read')).to.eq(true);
    expect(limited.truncated).to.eq(true);
  });

  it('refuses a bad argument without echoing it, and checks studio:read on each route', async () => {
    const statuses = await Promise.all(['routes?limit=0', 'routes?cursor=-1', 'authz/access-map?limit=0', 'authz/access-map?domain=nope'].map(async (q) => (await get(`/_studio/api/${q}`)).status));
    expect(statuses).to.deep.eq([400, 400, 400, 400]);
    const bad = await get('/_studio/api/authz/access-map?domain=zz%2Fqq%3C');
    expect(bad.status).to.eq(400);
    expect(bad.text).to.not.include('zz/qq<');
    expect((await get('/_studio/api/routes', 'alice')).status).to.eq(403);
    expect((await get('/_studio/api/authz/access-map', 'alice')).status).to.eq(403);
  });
});
