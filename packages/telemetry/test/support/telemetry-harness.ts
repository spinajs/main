import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { BaseController, BasePath, Controllers, Del, Get, Ok, Patch, Post, Put, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { PrincipalSource } from '@spinajs/authz-http';
import { hostHarness } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HttpHandle, HttpRequest, HttpResponse, RouteSpec, World } from '@spinajs/authz-testing';

import { TelemetryAccess } from '../../src/index.js';
import { startApp, stopApp } from './app.js';
import type { TestApp } from './app.js';

const PRINCIPAL_HEADER = 'x-behaviour-principal';
const SLOT_PREFIX = 'telemetry.auth.policies.';
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

const METHODS = { GET: Get, POST: Post, PUT: Put, PATCH: Patch, DELETE: Del } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf of `value` with its path, so a world section merges into the app config key by key. */
function leaves(value: unknown, path: string[] = []): [string[], unknown][] {
  if (!isRecord(value) || Object.keys(value).length === 0) return [[path, value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
}

/** The routes of one case under `/<prefix>`; a `configPolicy` of `telemetry.auth.policies.<endpoint>` becomes `@TelemetryAccess('<endpoint>')`. */
function caseController(prefix: string, world: World): Class<BaseController> {
  const Routes = class extends BaseController {};
  Object.defineProperty(Routes, 'name', { value: `TelemetryBehaviourRoutes_${prefix}` });
  const proto = Routes.prototype as unknown as Record<string, unknown>;

  (world.lane?.http?.routes ?? []).forEach((spec: RouteSpec, i) => {
    if (spec.access || spec.policies || spec.anonymous || spec.unscoped || (spec.handler !== undefined && spec.handler !== 'principal')) {
      throw new Error(`the telemetry harness serves only configPolicy routes with the principal handler: ${spec.method} ${spec.path}`);
    }
    if (!spec.configPolicy?.startsWith(SLOT_PREFIX)) {
      throw new Error(`the telemetry harness knows only ${SLOT_PREFIX}<endpoint> slots, got ${String(spec.configPolicy)}`);
    }

    const key = `route${i}`;
    proto[key] = async function (req: Request) {
      return new Ok({ principal: req.storage.Principal ?? null });
    };
    Reflect.defineMetadata('design:paramtypes', [Object], Routes.prototype, key);
    const descriptor = Object.getOwnPropertyDescriptor(Routes.prototype, key)!;
    TelemetryAccess(spec.configPolicy.slice(SLOT_PREFIX.length))(Routes.prototype, key, descriptor);
    METHODS[spec.method](spec.path.replace(/^\//, ''))(Routes.prototype, key, descriptor);
    Req()(Routes.prototype, key, 0);
  });

  BasePath(prefix)(Routes);
  return Routes as unknown as Class<BaseController>;
}

/**
 * hostHarness plus an http server for the telemetry config slots (B23.configNamed): each case's
 * `world.lane.http.routes` become a controller under a fresh path prefix, `world.lane.http.config`
 * merges into the app configuration, and `telemetry.auth.domain` points the slots at the case's
 * domain. Lane handle: `http`.
 */
export function telemetryHarness(): BehaviourHarness {
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
    facets: ['http'],
    register(host) {
      for (const [path, value] of leaves(host.world.lane?.http?.config ?? {})) if (path.length > 0) host.setConfig(path, value);
      host.setConfig(['telemetry', 'auth', 'domain'], host.domain);
      registered.push(caseController(`tc${++caseNo}`, host.world));
    },
    async extend() {
      const prefix = `tc${caseNo}`;
      const controllers = (await DI.resolve(Controllers)) as Controllers;
      for (const c of registered) await controllers.add(c);

      const request = async (req: HttpRequest): Promise<HttpResponse> => {
        let r = app!.request()[req.method.toLowerCase() as 'get'](`/${prefix}${req.path}`).set('Accept', 'application/json');
        if (req.principal) {
          const key = randomUUID();
          principals.set(key, req.principal);
          r = r.set(PRINCIPAL_HEADER, key);
        }
        for (const [name, value] of Object.entries(req.headers ?? {})) r = r.set(name, value);
        const res = req.body !== undefined ? await r.send(req.body as object) : await r;
        return { status: res.status, body: res.body };
      };

      const http: HttpHandle = { request, logs: () => [] };
      return { lane: { http }, dispose: async () => unregisterCase() } as Partial<HarnessSession>;
    },
  });

  return {
    ...base,
    async beforeAll() {
      DI.register(BehaviourPrincipalSource).as(PrincipalSource);
      app = await startApp();
      await base.beforeAll?.();
    },
    async afterAll() {
      await base.afterAll?.();
      await stopApp();
      DI.unregister(BehaviourPrincipalSource);
      DI.uncache(BehaviourPrincipalSource);
      DI.uncache(PrincipalSource);
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
