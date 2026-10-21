import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { BaseController, BasePath, Ok, Post } from '../src/index.js';
import { MemoryThrottleStore, ThrottleMiddleware, IThrottleRule, ThrottleStore } from '../src/middlewares/Throttle.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { boot, disposeBooted, readingFrom } from './support/config-boot.js';

interface IFakeResult {
  nextCalled: boolean;
  nextError?: unknown;
  status?: number;
  body?: any;
  headers: Record<string, string>;
}

/** A ThrottleMiddleware reading `http.throttle` (absent when undefined) from a Configuration the http schema checked. */
async function makeMiddleware(cfg: { enabled?: boolean; rules?: IThrottleRule[]; ipv6Prefix?: number } | undefined, store?: ThrottleStore) {
  const { child } = await boot([HTTP_CONFIGURATION_SCHEMA], cfg === undefined ? {} : { http: { throttle: cfg } });
  const mw = readingFrom(new ThrottleMiddleware(), child);
  // decorator-injected properties are getter-only; redefine them for the unit test
  Object.defineProperty(mw, 'Store', { value: store ?? new MemoryThrottleStore() });
  Object.defineProperty(mw, 'Log', { value: { warn: sinon.stub() } });
  return mw;
}

function run(handler: (req: any, res: any, next: any) => void, req: any): Promise<IFakeResult> {
  return new Promise((resolve, reject) => {
    const result: IFakeResult = { nextCalled: false, headers: {} };
    const res = {
      set(name: string, value: string) {
        result.headers[name] = value;
        return this;
      },
      status(code: number) {
        result.status = code;
        return this;
      },
      json(body: any) {
        result.body = body;
        resolve(result);
      },
    };
    const next = (err?: unknown) => {
      result.nextCalled = true;
      result.nextError = err;
      resolve(result);
    };

    try {
      handler(req, res, next);
    } catch (err) {
      reject(err);
    }
  });
}

function request(overrides?: Partial<{ path: string; method: string; ip: string }>) {
  const ip = overrides?.ip ?? '1.2.3.4';
  return {
    path: overrides?.path ?? '/auth/login',
    method: overrides?.method ?? 'POST',
    ip,
    storage: { realIp: ip },
  };
}

/** The paths a controller mounts, given the config values its @BasePath reads. */
async function mountedPaths(type: new () => BaseController, values: Record<string, unknown>): Promise<string[]> {
  const controller = new type();
  const cfg = { get: (path: string, fallback?: unknown) => (path in values ? values[path] : fallback) };
  const noop = () => {};
  const log = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, security: noop, success: noop };
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: log, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(controller, name, { value });
  }
  await controller.resolve();
  return (controller.Router as unknown as { stack: { route: { path: string } }[] }).stack.map((l) => l.route.path);
}

@BasePath({ config: 'throttle.test.base', default: 'auth/probe' })
class RelocatableController extends BaseController {
  @Post()
  public async probe() {
    return new Ok('ok');
  }
}

describe('ThrottleMiddleware', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeBooted();
  });

  describe('MemoryThrottleStore', () => {
    it('counts hits within one window', () => {
      const store = new MemoryThrottleStore();

      expect(store.increment('k', 60).count).to.eq(1);
      expect(store.increment('k', 60).count).to.eq(2);
      expect(store.increment('other', 60).count).to.eq(1);
    });

    it('starts a fresh window once the previous one expires', () => {
      const clock = sinon.useFakeTimers();
      const store = new MemoryThrottleStore();

      expect(store.increment('k', 10).count).to.eq(1);
      expect(store.increment('k', 10).count).to.eq(2);

      clock.tick(10_001);

      expect(store.increment('k', 10).count).to.eq(1);
    });
  });

  describe('configuration gate', () => {
    it('is a no-op when disabled or unconfigured', async () => {
      expect((await makeMiddleware(undefined)).before()).to.be.null;
      expect((await makeMiddleware({ enabled: false, rules: [{ path: '/', limit: 1, windowSeconds: 1 }] })).before()).to.be.null;
    });

    it('refuses a rule set past the schema whose limit or window is not a finite number, rather than never throttling', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ path: '/auth', windowSeconds: 60 }, 'http.throttle.rules.0.limit'],
        [{ path: '/auth', limit: NaN, windowSeconds: 60 }, 'http.throttle.rules.0.limit'],
        [{ path: '/auth', limit: 5 }, 'http.throttle.rules.0.windowSeconds'],
        [{ path: '/auth', limit: 5, windowSeconds: 0 }, 'http.throttle.rules.0.windowSeconds'],
        [{ path: '/auth', limit: 5, windowSeconds: Infinity }, 'http.throttle.rules.0.windowSeconds'],
      ];
      for (const [rule, key] of cases) {
        const { child } = await boot([HTTP_CONFIGURATION_SCHEMA], { http: { throttle: { enabled: true } } });
        ((await child.resolve(Configuration)) as Configuration).set(['http', 'throttle', 'rules'], [rule]);
        const mw = readingFrom(new ThrottleMiddleware(), child);
        expect(() => mw.before(), JSON.stringify(rule)).to.throw(InvalidOption, key);
      }
    });

    it('keeps a limit of 0 set past the schema: every matching request is refused', async () => {
      const { child } = await boot([HTTP_CONFIGURATION_SCHEMA], { http: { throttle: { enabled: true } } });
      ((await child.resolve(Configuration)) as Configuration).set(['http', 'throttle', 'rules'], [{ path: '/auth', limit: 0, windowSeconds: 60 }]);
      const mw = readingFrom(new ThrottleMiddleware(), child);
      Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });
      Object.defineProperty(mw, 'Log', { value: { warn: sinon.stub() } });

      expect((await run(mw.before()!, request())).status).to.eq(429);
    });

    it('is a no-op when enabled without rules', async () => {
      expect((await makeMiddleware({ enabled: true, rules: [] })).before()).to.be.null;
      expect((await makeMiddleware({ enabled: true })).before()).to.be.null;
    });
  });

  describe('rules and a controller moved by @BasePath({ config })', () => {
    const RULE: IThrottleRule[] = [{ path: '/auth/probe', methods: ['POST'], limit: 1, windowSeconds: 60 }];

    it('match the resolved path: a rule on the default path no longer covers the moved route, a rule on the new one does', async () => {
      const [moved] = await mountedPaths(RelocatableController, { 'throttle.test.base': 'admin/probe' });
      const [home] = await mountedPaths(RelocatableController, {});
      expect(moved).to.eq('/admin/probe/probe');
      expect(home).to.eq('/auth/probe/probe');

      const stale = (await makeMiddleware({ enabled: true, rules: RULE })).before()!;
      for (let i = 0; i < 3; i++) expect((await run(stale, request({ path: moved }))).nextCalled, 'moved route, default-path rule').to.eq(true);

      const current = (await makeMiddleware({ enabled: true, rules: [{ path: '/admin/probe', methods: ['POST'], limit: 1, windowSeconds: 60 }] })).before()!;
      expect((await run(current, request({ path: moved }))).nextCalled).to.eq(true);
      expect((await run(current, request({ path: moved }))).status).to.eq(429);

      const atHome = (await makeMiddleware({ enabled: true, rules: RULE })).before()!;
      await run(atHome, request({ path: home }));
      expect((await run(atHome, request({ path: home }))).status).to.eq(429);
    });
  });

  describe('limiting', () => {
    const RULES: IThrottleRule[] = [{ path: '/auth', methods: ['POST'], limit: 2, windowSeconds: 60 }];

    it('passes requests under the limit and refuses the first one over it with 429', async () => {
      const handler = (await makeMiddleware({ enabled: true, rules: RULES })).before()!;

      expect((await run(handler, request())).nextCalled).to.eq(true);
      expect((await run(handler, request())).nextCalled).to.eq(true);

      const limited = await run(handler, request());
      expect(limited.nextCalled).to.eq(false);
      expect(limited.status).to.eq(429);
      expect(limited.body.error.code).to.eq('E_TOO_MANY_REQUESTS');
      expect(Number(limited.headers['Retry-After'])).to.be.greaterThan(0);
      expect(limited.headers['X-RateLimit-Remaining']).to.eq('0');
    });

    it('counts per client ip', async () => {
      const handler = (await makeMiddleware({ enabled: true, rules: RULES })).before()!;

      await run(handler, request());
      await run(handler, request());
      expect((await run(handler, request())).status).to.eq(429);

      // another address is not affected
      expect((await run(handler, request({ ip: '5.6.7.8' }))).nextCalled).to.eq(true);
    });

    it('counts the addresses of one IPv6 /64 together and another /64 apart', async () => {
      const handler = (await makeMiddleware({ enabled: true, rules: RULES })).before()!;

      expect((await run(handler, request({ ip: '2001:db8::1' }))).nextCalled).to.eq(true);
      expect((await run(handler, request({ ip: '2001:db8::2' }))).nextCalled).to.eq(true);
      expect((await run(handler, request({ ip: '2001:db8:0:0:ffff::9' }))).status).to.eq(429);
      expect((await run(handler, request({ ip: '2001:db8:0:1::1' }))).nextCalled).to.eq(true);
    });

    it('keys IPv6 on http.throttle.ipv6Prefix, and IPv4 whole', async () => {
      const handler = (await makeMiddleware({ enabled: true, rules: RULES, ipv6Prefix: 48 })).before()!;

      await run(handler, request({ ip: '2001:db8:0:1::1' }));
      await run(handler, request({ ip: '2001:db8:0:2::1' }));
      expect((await run(handler, request({ ip: '2001:db8:0:3::1' }))).status).to.eq(429);

      await run(handler, request({ ip: '192.0.2.1' }));
      await run(handler, request({ ip: '192.0.2.1' }));
      expect((await run(handler, request({ ip: '192.0.2.1' }))).status).to.eq(429);
      expect((await run(handler, request({ ip: '192.0.2.2' }))).nextCalled).to.eq(true);
    });

    it('ignores paths and methods outside the rules', async () => {
      const handler = (await makeMiddleware({ enabled: true, rules: RULES })).before()!;

      for (let i = 0; i < 5; i++) {
        expect((await run(handler, request({ path: '/api/users' }))).nextCalled).to.eq(true);
        expect((await run(handler, request({ method: 'GET' }))).nextCalled).to.eq(true);
      }
    });

    it('matches by path prefix', async () => {
      const handler = (await makeMiddleware({ enabled: true, rules: RULES })).before()!;

      await run(handler, request({ path: '/auth/password/reset-request' }));
      await run(handler, request({ path: '/auth/password/reset-request' }));

      const limited = await run(handler, request({ path: '/auth/password/reset-request' }));
      expect(limited.status).to.eq(429);
    });

    it('hands a counter store failure to the error handler', async () => {
      const broken: ThrottleStore = {
        increment: () => Promise.reject(new Error('store down')),
      } as ThrottleStore;
      const handler = (await makeMiddleware({ enabled: true, rules: RULES }, broken)).before()!;

      const result = await run(handler, request());
      expect(result.nextCalled).to.eq(true);
      expect(result.nextError).to.be.instanceOf(Error);
    });
  });
});
