import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthorizationModel } from '@spinajs/authz';
import type { DecisionRequest } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, Get, Ok, Req } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { FrameworkLogger } from '@spinajs/log';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { TelemetryAccess, TelemetryAccessPolicy, isExplicitDevelopment, telemetrySkipsAuth } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

class RefusingTestPolicy extends BasePolicy {
  public isEnabled() {
    return true;
  }
  public async execute() {
    throw new Forbidden('refused by RefusingTestPolicy');
  }
}

class DisabledTestPolicy extends BasePolicy {
  public isEnabled() {
    return false;
  }
  public async execute() {
    throw new Forbidden('a disabled policy must not run');
  }
}

const TEST_POLICIES: Class<BasePolicy>[] = [RefusingTestPolicy, DisabledTestPolicy];

// bob: telemetry:read; carol: telemetry:write; alice: nothing.
const votes = (req: DecisionRequest): ScriptedVote => {
  if (req.principal.id === 'bob' && req.permission === 'telemetry:read') return { permitWhen: { op: 'true' } };
  if (req.principal.id === 'carol' && req.permission === 'telemetry:write') return { permitWhen: { op: 'true' } };
  return {};
};

const decision = (req: Request) => new Ok({ allowed: req.storage.AuthzDecision?.allowed ?? null });

@BasePath('tel-access')
class AccessRoutes extends BaseController {
  @Get('read')
  @TelemetryAccess('read')
  public read(@Req() req: Request) {
    return decision(req);
  }

  @Get('any')
  @TelemetryAccess('any')
  public any(@Req() req: Request) {
    return decision(req);
  }

  @Get('open')
  @TelemetryAccess('open')
  public open(@Req() req: Request) {
    return decision(req);
  }

  @Get('refused')
  @TelemetryAccess('refused')
  public refused(@Req() req: Request) {
    return decision(req);
  }
}

@BasePath('tel-broken')
class BrokenRoutes extends BaseController {
  @Get('x')
  @TelemetryAccess('broken')
  public x(@Req() req: Request) {
    return decision(req);
  }
}

@BasePath('tel-dev')
class DevelopmentRoutes extends BaseController {
  @Get('read')
  @TelemetryAccess('read')
  public read(@Req() req: Request) {
    return decision(req);
  }

  @Get('refused')
  @TelemetryAccess('refused')
  public refused(@Req() req: Request) {
    return decision(req);
  }
}

const SLOTS = {
  'telemetry.auth.policies.read': 'AccessPolicy',
  'telemetry.auth.permissions.read': 'telemetry:read',
  'telemetry.auth.policies.any': 'AccessPolicy',
  'telemetry.auth.permissions.any': ['telemetry:write', 'telemetry:read'],
  'telemetry.auth.policies.open': 'PublicPolicy',
  'telemetry.auth.policies.refused': 'RefusingTestPolicy',
};

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(env);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

describe('TelemetryAccessPolicy', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregisterSource: () => void;

  const get = (path: string, user?: string) => {
    const r = app.request().get(path).set('Accept', 'application/json');
    return user ? r.set('x-user', user) : r;
  };

  before(async () => {
    for (const p of TEST_POLICIES) DI.register(p).as(BasePolicy);
    unregisterSource = registerHeaderSource();
    testHost.registerInRoot(AuthorizationModel, testHost.instance(new StaticModel({ name: 'm1', votes })));
    app = await startApp({
      controllers: [AccessRoutes],
      config: {
        'authz.permissions': { 'telemetry:read': {}, 'telemetry:write': {} },
        'authz.combine': { default: { algorithm: 'deny-overrides', models: ['m1'] } },
        'authz.cache': { maxEntries: 0 },
        ...SLOTS,
      },
    });
  });

  after(async () => {
    await stopApp();
    unregisterSource?.();
    for (const p of TEST_POLICIES) {
      DI.unregister(p);
      DI.uncache(p);
    }
    DI.uncache(BasePolicy);
  });

  describe('registration fails closed', () => {
    const touched: string[][] = [];
    const set = (path: string, value: unknown) => {
      touched.push(path.split('.'));
      testHost.config().set(path.split('.'), value);
    };

    afterEach(() => {
      for (const path of touched.splice(0)) testHost.config().unset(path);
    });

    const refuses = (endpoint: string, message: RegExp) => expect(() => new TelemetryAccessPolicy(endpoint)).to.throw(message);

    it('when the slot is missing', () => {
      refuses('nothing', /telemetry\.auth\.policies\.nothing/);
    });

    it('when the slot is empty', () => {
      set('telemetry.auth.policies.broken', '');
      refuses('broken', /telemetry\.auth\.policies\.broken/);
    });

    it('when the slot is not a string', () => {
      set('telemetry.auth.policies.broken', ['AccessPolicy']);
      refuses('broken', /telemetry\.auth\.policies\.broken/);
      set('telemetry.auth.policies.broken', 42);
      refuses('broken', /telemetry\.auth\.policies\.broken/);
    });

    it('when the slot names no registered BasePolicy', () => {
      set('telemetry.auth.policies.broken', 'NoSuchPolicy');
      refuses('broken', /NoSuchPolicy/);
    });

    it('when the slot names TelemetryAccessPolicy itself', () => {
      set('telemetry.auth.policies.broken', 'TelemetryAccessPolicy');
      refuses('broken', /must not name TelemetryAccessPolicy itself/);
    });

    it("when an 'AccessPolicy' slot has no permission entry", () => {
      set('telemetry.auth.policies.broken', 'AccessPolicy');
      refuses('broken', /telemetry\.auth\.permissions\.broken/);
    });

    it("when an 'AccessPolicy' slot has an empty permission entry", () => {
      set('telemetry.auth.policies.broken', 'AccessPolicy');
      for (const empty of ['', []]) {
        set('telemetry.auth.permissions.broken', empty);
        refuses('broken', /telemetry\.auth\.permissions\.broken/);
      }
    });

    it("when an 'AccessPolicy' slot names an invalid permission", () => {
      set('telemetry.auth.policies.broken', 'AccessPolicy');
      for (const invalid of ['telemetry', ['telemetry:read', 'read'], ['telemetry:read', 42], 7]) {
        set('telemetry.auth.permissions.broken', invalid);
        refuses('broken', /telemetry\.auth\.permissions\.broken/);
      }
    });

    it('when telemetry.auth.domain is set but not a non-empty string', () => {
      set('telemetry.auth.policies.broken', 'AccessPolicy');
      set('telemetry.auth.permissions.broken', 'telemetry:read');
      set('telemetry.auth.domain', '');
      refuses('broken', /telemetry\.auth\.domain/);
    });

    it("even under the development skip, when an 'AccessPolicy' slot has no permission entry", async () => {
      set('telemetry.auth.policies.broken', 'AccessPolicy');
      set('telemetry.auth.skipInDevelopment', true);
      await withEnv({ APP_ENV: 'development' }, async () => {
        expect(telemetrySkipsAuth(), 'the skip is active').to.eq(true);
        refuses('broken', /telemetry\.auth\.permissions\.broken/);
      });
    });

    it('so http refuses to register the route', async () => {
      set('telemetry.auth.policies.broken', 'NoSuchPolicy');
      let thrown: unknown;
      try {
        await app.controllers.add(BrokenRoutes);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'the controller must not register').to.be.instanceOf(Error);
      expect((thrown as Error).message).to.match(/NoSuchPolicy/);
      expect((await get('/tel-broken/x', 'bob')).status).to.eq(404);
    });
  });

  describe('a slot naming a BasePolicy', () => {
    it('delegates to it: PublicPolicy lets an anonymous request through', async () => {
      const res = await get('/tel-access/open');
      expect(res.status).to.eq(200);
    });

    it('delegates to it: a refusing policy refuses even a permitted principal', async () => {
      const res = await get('/tel-access/refused', 'bob');
      expect(res.status).to.eq(403);
    });

    it('delegates isEnabled to it', () => {
      const route = {} as IRoute;
      const controller = {} as IController;
      testHost.config().set(['telemetry', 'auth', 'policies', 'disabled'], 'DisabledTestPolicy');
      try {
        expect(new TelemetryAccessPolicy('disabled').isEnabled(route, controller)).to.eq(false);
        expect(new TelemetryAccessPolicy('refused').isEnabled(route, controller)).to.eq(true);
      } finally {
        testHost.config().unset(['telemetry', 'auth', 'policies', 'disabled']);
      }
    });
  });

  describe("an 'AccessPolicy' slot", () => {
    it('answers an anonymous request 401', async () => {
      const res = await get('/tel-access/read');
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.include({ error: 'unauthenticated' });
    });

    it('answers a request without a principal 401', async () => {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
      try {
        const res = await get('/tel-access/read');
        expect(res.status).to.eq(401);
        expect(res.body).to.deep.include({ error: 'unauthenticated' });
      } finally {
        testHost.config().unset(['authz', 'principals', 'anonymous', 'enabled']);
      }
    });

    it('answers a principal without the permission 403 naming the permission', async () => {
      const res = await get('/tel-access/read', 'alice');
      expect(res.status).to.eq(403);
      expect(res.body).to.deep.include({ error: 'forbidden', permission: 'telemetry:read', resource: { type: 'telemetry' } });
    });

    it('lets a principal with the permission through and keeps the decision in req.storage.AuthzDecision', async () => {
      const res = await get('/tel-access/read', 'bob');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ allowed: true });
    });

    it('treats a list of permissions as any of them', async () => {
      expect((await get('/tel-access/any', 'bob')).status).to.eq(200);
      expect((await get('/tel-access/any', 'carol')).status).to.eq(200);
      expect((await get('/tel-access/any', 'alice')).status).to.eq(403);
    });
  });

  describe('development skip', () => {
    const FLAG = ['telemetry', 'auth', 'skipInDevelopment'];
    const PRODUCTION = ['configuration', 'isProduction'];

    afterEach(() => {
      testHost.config().unset(FLAG);
      testHost.config().unset(PRODUCTION);
    });

    it('holds only for APP_ENV, else NODE_ENV, naming development; a missing env counts as production', () => {
      expect(isExplicitDevelopment({ APP_ENV: 'development' })).to.eq(true);
      expect(isExplicitDevelopment({ NODE_ENV: 'dev' })).to.eq(true);
      expect(isExplicitDevelopment({ APP_ENV: 'production', NODE_ENV: 'development' })).to.eq(false);
      expect(isExplicitDevelopment({})).to.eq(false);
      expect(isExplicitDevelopment({ APP_ENV: '' })).to.eq(false);
    });

    it('flag off, development env: checked', () => {
      expect(telemetrySkipsAuth({ APP_ENV: 'development' })).to.eq(false);
    });

    it('flag not exactly true, development env: checked', () => {
      testHost.config().set(FLAG, 'true');
      expect(telemetrySkipsAuth({ APP_ENV: 'development' })).to.eq(false);
    });

    it('flag on, env missing: checked', () => {
      testHost.config().set(FLAG, true);
      expect(telemetrySkipsAuth({})).to.eq(false);
    });

    it('flag on, NODE_ENV=production: checked', () => {
      testHost.config().set(FLAG, true);
      expect(telemetrySkipsAuth({ NODE_ENV: 'production' })).to.eq(false);
    });

    it('flag on, APP_ENV=development: skipped', () => {
      testHost.config().set(FLAG, true);
      expect(telemetrySkipsAuth({ APP_ENV: 'development' })).to.eq(true);
    });

    it('flag on, development env, configuration.isProduction true: checked', () => {
      testHost.config().set(FLAG, true);
      testHost.config().set(PRODUCTION, true);
      expect(telemetrySkipsAuth({ APP_ENV: 'development' })).to.eq(false);
    });

    it('is decided when the route registers: such a route skips the check, logs a warning, and named slots still run', async () => {
      const warnings: string[] = [];
      const proto = FrameworkLogger.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
      const warn = proto.warn;
      proto.warn = function (this: unknown, ...args: unknown[]) {
        warnings.push(args.filter((a) => typeof a === 'string').join(' '));
        return warn.apply(this, args);
      };

      try {
        testHost.config().set(FLAG, true);
        await withEnv({ APP_ENV: 'development' }, () => app.controllers.add(DevelopmentRoutes));
      } finally {
        proto.warn = warn;
        testHost.config().unset(FLAG);
      }

      expect(warnings.some((w) => /skip/i.test(w) && w.includes('read')), `a warning naming the endpoint, got: ${JSON.stringify(warnings)}`).to.eq(true);
      expect((await get('/tel-dev/read')).status).to.eq(200);
      expect((await get('/tel-dev/refused', 'bob')).status).to.eq(403);
      expect((await get('/tel-access/read')).status, 'routes registered without the skip stay checked').to.eq(401);
    });
  });
});
