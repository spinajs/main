import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import type { Class, Constructor } from '@spinajs/di';
import { AuthorizationModel } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Body, Controllers, Del, Get, Ok, Patch, Policy, Post, Put, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { FrameworkLogger } from '@spinajs/log';
import { StaticModel, hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HttpHandle, HttpRequest, HttpResponse, LinkSourceHandle, LogRecord, RouteSpec, TestPolicy, World, WorldLink } from '@spinajs/authz-testing';
import { linkPrincipal } from '@spinajs/authz-testing';

import { Access, AccessController, AllowAnonymous, ExplainController, ExplainControllerSource, LinkResolver, PrincipalSource, Unscoped, fromBody, fromParam, fromQuery } from '../../src/index.js';
import { startApp, stopApp } from './app.js';
import type { TestApp } from './app.js';

// The in-memory test configuration applies no schema defaults.
const AUTHZ_HTTP_TEST_DEFAULTS: [string[], unknown][] = [
  [['authz', 'http', 'services'], []],
  [['authz', 'http', 'explainRoute', 'enabled'], false],
  [['authz', 'http', 'explainRoute', 'permission'], 'authz:explain'],
  [['authz', 'http', 'links', 'query'], 'link'],
  [['authz', 'http', 'links', 'header'], 'X-Authz-Link'],
  [['authz', 'http', 'links', 'cookie'], null],
  [['authz', 'http', 'access', 'domain'], 'root'],
  [['authz', 'http', 'admin', 'domain'], 'root'],
];

const PRINCIPAL_HEADER = 'x-behaviour-principal';
const principals = new Map<string, Principal>();

/** Yields the principal the case's request names: `HttpRequest.principal` travels as a key into this map. */
class BehaviourPrincipalSource extends PrincipalSource {
  public readonly name = 'behaviour';
  public readonly order = 45;

  public async authenticate(req: Request): Promise<Principal | null> {
    const key = req.headers[PRINCIPAL_HEADER];
    return typeof key === 'string' ? principals.get(key) ?? null : null;
  }
}

let currentLinks: readonly WorldLink[] | undefined;

/** Opens the world's links (`world.rbac.links`) as RbacService.linkPrincipal would (L1b); an unknown token opens a dead link. */
class WorldLinkResolver extends LinkResolver {
  public async principal(token: string, companion?: Principal): Promise<Principal> {
    const link = (currentLinks ?? []).find((l) => l.token === token);
    const p = link && !link.revoked ? linkPrincipal(link.id, { scope: [link.scope], attributes: link.attributes ?? {}, ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}) }) : linkPrincipal(link?.id ?? 'unknown', { scope: [] });
    return companion ? { ...p, companions: [{ type: companion.type, id: companion.id }] } : p;
  }
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security'] as const;
const records: LogRecord[] = [];
const isTrace = (v: unknown) => typeof v === 'object' && v !== null && 'votes' in v && 'steps' in v && 'algorithm' in v;
let restoreLogs: (() => void) | undefined;

function captureLogs(): () => void {
  const proto = FrameworkLogger.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = LEVELS.map((level) => [level, proto[level]] as const).filter(([, fn]) => typeof fn === 'function');
  for (const [level, fn] of originals) {
    proto[level] = function (this: unknown, ...args: unknown[]) {
      const message = args.find((a) => typeof a === 'string') as string | undefined;
      records.push({ level, message: message ?? '', trace: args.some(isTrace) });
      return fn.apply(this, args);
    };
  }
  return () => {
    for (const [level, fn] of originals) proto[level] = fn;
  };
}

const METHODS = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Del } as const;

function testPolicy(spec: TestPolicy): Class<BasePolicy> {
  const P = class extends BasePolicy {
    public isEnabled() {
      return true;
    }
    public async execute() {
      if (!spec.passes) throw new Forbidden(`${spec.name} refused`);
    }
  };
  Object.defineProperty(P, 'name', { value: `Policy${spec.name}` });
  return P;
}

function rowOf(world: World, ref: ResourceRef): unknown {
  for (const a of world.adapters ?? []) {
    const row = (a.rows?.[ref.type] ?? []).find((r) => r.id === ref.id);
    if (row) return structuredClone(row);
  }
  return null;
}

function decorate(target: object, key: string, decorators: ((target: object, key: string, d: PropertyDescriptor) => void)[]) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
  for (const d of [...decorators].reverse()) d(target, key, descriptor);
}

/** The controller of one case: `world.lane.http.routes` under `/<prefix>`, plus a bare principal route for the link handle. */
function caseController(prefix: string, world: World, domain: string): Class<BaseController> {
  const Routes = class extends BaseController {};
  Object.defineProperty(Routes, 'name', { value: `BehaviourRoutes_${prefix}` });
  const proto = Routes.prototype as unknown as Record<string, unknown>;

  const routes: RouteSpec[] = [...(world.lane?.http?.routes ?? []), { method: 'GET', path: '/__principal', handler: 'principal' }];
  routes.forEach((spec, i) => {
    const key = `route${i}`;
    const handler = spec.handler ?? 'principal';
    proto[key] = async function (req: Request, body: unknown) {
      if (handler === 'principal') return new Ok({ principal: req.storage.Principal ?? null });
      if (handler === 'echo') return new Ok(body ?? null);
      if ('returns' in handler) return new Ok(rowOf(world, handler.returns));
      throw new Error('the http harness has no ORM: route handler { orm } needs the orm facet (L4)');
    };
    Reflect.defineMetadata('design:paramtypes', [Object, Object], Routes.prototype, key);

    const decorators: ((t: object, k: string, d: PropertyDescriptor) => void)[] = [METHODS[spec.method](spec.path.replace(/^\//, '')) as never];
    const access = spec.access;
    if (access) {
      const r = access.resource;
      const resource = r ? (r.from === 'param' ? fromParam(r.name, r.type) : r.from === 'body' ? fromBody(r.name, r.type) : fromQuery(r.name, r.type)) : undefined;
      decorators.push(
        Access(access.permission, {
          domain: access.domain ?? domain,
          ...(resource ? { resource } : {}),
          ...(access.also ? { also: access.also.map(testPolicy) } : {}),
          ...(access.subject ? { subject: access.subject } : {}),
          ...(access.fields ? { fields: access.fields } : {}),
        }) as never,
      );
    }
    if (spec.anonymous) decorators.push(AllowAnonymous() as never);
    if (spec.unscoped) decorators.push(Unscoped(spec.unscoped) as never);
    for (const p of spec.policies ?? []) decorators.push(Policy(testPolicy(p) as Constructor<BasePolicy>) as never);
    decorate(Routes.prototype, key, decorators);
    Req()(Routes.prototype, key, 0);
    Body()(Routes.prototype, key, 1);
  });

  BasePath(prefix)(Routes);
  return Routes as unknown as Class<BaseController>;
}

function under<T extends Class<BaseController>>(base: T, path: string): Class<BaseController> {
  const Sub = class extends (base as unknown as new () => BaseController) {};
  Object.defineProperty(Sub, 'name', { value: `${base.name}_${path.replace(/\W/g, '_')}` });
  BasePath(path)(Sub);
  return Sub as unknown as Class<BaseController>;
}

export interface HttpHarnessOptions {
  /** Default 'test'. */
  readonly domain?: string;
}

/**
 * hostHarness plus an http server: each case's `world.lane.http` routes become a controller under
 * a fresh path prefix (so earlier cases' routes are unreachable), with the access routes
 * (`/user/access`) and, when ExplainControllerSource hands it out, the explain route under the same
 * prefix. Lane handles: `http` and `linkSource`.
 */
export function httpHarness(opts: HttpHarnessOptions = {}): BehaviourHarness {
  const domain = opts.domain ?? 'test';
  let app: TestApp | undefined;
  let caseNo = 0;
  let registered: Class<BaseController>[] = [];

  const unregisterCase = () => {
    for (const c of registered) {
      // Controllers.add registers a type a second time.
      for (let i = 0; i < 3 && (DI.getRegisteredTypes(BaseController) ?? []).includes(c); i++) DI.unregister(c);
      DI.uncache(c);
    }
    registered = [];
    DI.uncache(BaseController);
  };

  const base = hostHarness({
    domain,
    facets: ['http', 'links'],
    register(host) {
      const world = host.world;
      currentLinks = world.rbac?.links;
      for (const [path, value] of AUTHZ_HTTP_TEST_DEFAULTS) if (testHost.config().get(path) === undefined) host.setConfig(path, value);
      if (world.lane?.http?.env !== undefined) host.setConfig(['configuration', 'isProduction'], world.lane.http.env === 'production');
      for (const [key, value] of Object.entries(world.lane?.http?.config ?? {})) host.setConfig([key], value);
      host.setConfig(['authz', 'http', 'access', 'domain'], domain);

      // Models of other lanes (the RBAC model of links and summaries) stand in as empty static models.
      const kitNames = new Set(host.kit.models.map((m) => m.name));
      const combined = new Set([world.combine.default, ...Object.values(world.combine.types ?? {})].flatMap((route) => route.models ?? []));
      for (const name of combined) if (!kitNames.has(name)) host.container.register(testHost.instance(new StaticModel({ name }))).as(AuthorizationModel);

      const prefix = `c${++caseNo}`;
      const routes = caseController(prefix, world, domain);
      DI.register(routes).as(BaseController);
      registered.push(routes);
    },
    async extend() {
      const prefix = `c${caseNo}`;
      const controllers = (await DI.resolve(Controllers)) as Controllers;
      const extra = [under(AccessController, `${prefix}/user/access`)];
      const source = (await DI.resolve(ExplainControllerSource)) as ExplainControllerSource;
      const explain = (await source.getControllers()).some((c) => c.type === ExplainController);
      if (explain) extra.push(under(ExplainController, `${prefix}/authz`));
      for (const c of [...registered, ...extra]) await controllers.add(c);
      registered.push(...extra);
      records.length = 0;

      const request = async (req: HttpRequest): Promise<HttpResponse> => {
        let r = app!.request()[req.method.toLowerCase() as 'get'](`/${prefix}${req.path}`);
        if (req.principal) {
          const key = randomUUID();
          principals.set(key, req.principal);
          r = r.set(PRINCIPAL_HEADER, key);
        }
        for (const [name, value] of Object.entries(req.headers ?? {})) r = r.set(name, value);
        const res = req.body !== undefined ? await r.send(req.body as object) : await r;
        return { status: res.status, body: res.body };
      };

      const http: HttpHandle = { request, logs: () => [...records] };
      const linkSource: LinkSourceHandle = {
        async principal({ token, in: where, session }) {
          const res = await request({
            method: 'GET',
            path: where === 'query' ? `/__principal?link=${encodeURIComponent(token)}` : '/__principal',
            ...(session ? { principal: session } : {}),
            ...(where === 'header' ? { headers: { 'X-Authz-Link': token } } : where === 'cookie' ? { headers: { Cookie: `link=${token}` } } : {}),
          });
          return (res.body as { principal: Principal | null }).principal;
        },
      };

      return { lane: { http, linkSource }, dispose: async () => unregisterCase() } as Partial<HarnessSession>;
    },
  });

  return {
    ...base,
    async beforeAll() {
      DI.register(BehaviourPrincipalSource).as(PrincipalSource);
      DI.register(WorldLinkResolver).as(LinkResolver);
      restoreLogs = captureLogs();
      app = await startApp();
      await base.beforeAll?.();
    },
    async afterAll() {
      await base.afterAll?.();
      await stopApp();
      restoreLogs?.();
      for (const t of [BehaviourPrincipalSource, WorldLinkResolver] as Class<unknown>[]) {
        DI.unregister(t);
        DI.uncache(t);
      }
      DI.uncache(PrincipalSource);
      DI.uncache(LinkResolver);
      principals.clear();
    },
    async setup(world, ctx) {
      try {
        return await base.setup(world, ctx);
      } catch (e) {
        unregisterCase();
        throw e;
      }
    },
  };
}
