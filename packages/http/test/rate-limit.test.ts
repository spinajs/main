import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import type { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import { createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, MemoryThrottleStore, Ok, Post, RateLimit, RateLimitMiddleware, ThrottleMiddleware, ThrottleStore } from '../src/index.js';
import type { IRoute, IThrottleRule } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { globalRouteMiddlewareDescriptors } from '../src/global-route-middlewares.js';

interface IRun {
  passed: boolean;
  error?: unknown;
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

const ROUTE = { InternalType: 'post', Method: 'login' } as unknown as IRoute;

async function makeMiddleware(options: { limit: number; windowSeconds: number; by?: 'ip' | 'principal' }, config: Record<string, unknown> = {}, store?: ThrottleStore): Promise<RateLimitMiddleware> {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config });
  const mw = readingFrom(new RateLimitMiddleware(options.limit, options.windowSeconds, options.by), container);
  Object.defineProperty(mw, 'Store', { value: store ?? new MemoryThrottleStore() });
  return mw;
}

async function registered(mw: RateLimitMiddleware, path = '/auth/login', route: IRoute = ROUTE): Promise<RateLimitMiddleware> {
  await mw.onRegister(route, path);
  return mw;
}

async function run(mw: RateLimitMiddleware, storage: Record<string, unknown> = { realIp: '1.2.3.4' }): Promise<IRun> {
  const result: IRun = { passed: false, headers: {} };
  const res = {
    set(name: string, value: string) {
      result.headers[name] = value;
      return this;
    },
  };
  try {
    const answer = await mw.onBefore({ req: { socket: {} } as never, res: res as never, storage: storage as never });
    if (answer) {
      result.status = answer.statusCode;
      result.body = answer.data;
    } else {
      result.passed = true;
    }
  } catch (err) {
    result.error = err;
  }
  return result;
}

const user = (id: string, authenticated = true) => ({ type: 'user', id, authenticated, source: 'session', attributes: {} });

@BasePath('rate-limited')
class RateLimitedController extends BaseController {
  @Post()
  @RateLimit(2, 60)
  public login() {
    return new Ok({ ok: true });
  }

  @Post()
  @RateLimit(2, 60)
  public other() {
    return new Ok({ ok: true });
  }

  @Get()
  public free() {
    return new Ok({ ok: true });
  }
}

describe('RateLimitMiddleware', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  describe('options', () => {
    it('refuses the route registration for a limit, window or key it cannot enforce', async () => {
      const bad: [number, number, unknown, string][] = [
        [NaN, 60, 'ip', 'limit'],
        [-1, 60, 'ip', 'limit'],
        [1.5, 60, 'ip', 'limit'],
        [5, 0, 'ip', 'windowSeconds'],
        [5, Infinity, 'ip', 'windowSeconds'],
        [5, 60, 'session', 'by'],
      ];
      for (const [limit, windowSeconds, by, name] of bad) {
        const mw = await makeMiddleware({ limit, windowSeconds, by: by as 'ip' });
        let error: unknown;
        try {
          await mw.onRegister(ROUTE, '/auth/login');
        } catch (err) {
          error = err;
        }
        expect((error as Error)?.message, `${limit}/${windowSeconds}/${String(by)}`).to.contain(name);
      }
    });

    it('refuses an http.throttle.ipv6Prefix outside 16..128 at registration', async () => {
      const { container } = await createTestApp({ scope: 'child', bootstrap: false, config: {} });
      const mw = readingFrom(new RateLimitMiddleware(1, 60), container);
      Object.defineProperty(mw, 'Ipv6Prefix', { value: 8 });
      let error: unknown;
      try {
        await mw.onRegister(ROUTE, '/auth/login');
      } catch (err) {
        error = err;
      }
      expect((error as Error)?.message).to.contain('ipv6Prefix');
    });

    it('is named in http.routes.middlewares with its options', () => {
      const cfg = { get: (path: string, fallback?: unknown) => (path === 'http.routes.middlewares' ? [{ service: 'RateLimitMiddleware', options: [600, 60] }] : fallback) } as unknown as Configuration;
      expect(globalRouteMiddlewareDescriptors(cfg, DI.RootContainer)).to.deep.eq([{ Type: RateLimitMiddleware, Options: [600, 60] }]);
    });

    it('keys ip by default', async () => {
      expect(new RateLimitMiddleware(1, 60).by).to.eq('ip');
    });
  });

  describe('limiting by ip', () => {
    it('passes requests under the limit and answers the first one over it with the 429 ThrottleMiddleware sends', async () => {
      const mw = await registered(await makeMiddleware({ limit: 2, windowSeconds: 60 }));

      const first = await run(mw);
      expect(first.passed).to.eq(true);
      expect(first.headers['X-RateLimit-Limit']).to.eq('2');
      expect(first.headers['X-RateLimit-Remaining']).to.eq('1');
      expect(Number(first.headers['X-RateLimit-Reset'])).to.be.greaterThan(Date.now() / 1000);
      expect((await run(mw)).passed).to.eq(true);

      const limited = await run(mw);
      expect(limited.passed).to.eq(false);
      expect(limited.status).to.eq(429);
      expect(limited.headers['X-RateLimit-Remaining']).to.eq('0');
      expect(Number(limited.headers['Retry-After'])).to.be.within(1, 60);

      const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { throttle: { enabled: true, rules: [{ path: '/', limit: 1, windowSeconds: 60 }] as IThrottleRule[] } } } });
      const throttle = readingFrom(new ThrottleMiddleware(), container);
      Object.defineProperty(throttle, 'Store', { value: { increment: () => ({ count: 2, resetAt: Date.now() + 60_000 }) } });
      Object.defineProperty(throttle, 'Log', { value: { warn: sinon.stub() } });
      const throttled = await throttle.onBefore({ req: { path: '/x', method: 'GET', socket: {} } as never, res: { set: () => undefined } as never, storage: { realIp: '1.2.3.4' } as never });
      expect(JSON.stringify(limited.body)).to.eq(JSON.stringify((await throttled)!.data));
    });

    it('counts per client address, an IPv6 /64 as one client', async () => {
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60 }));

      expect((await run(mw, { realIp: '2001:db8::1' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '2001:db8::2' })).status).to.eq(429);
      expect((await run(mw, { realIp: '2001:db8:0:1::1' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '192.0.2.1' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '192.0.2.2' })).passed).to.eq(true);
    });

    it('keys IPv6 on http.throttle.ipv6Prefix', async () => {
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60 }, { http: { throttle: { ipv6Prefix: 48 } } }));

      expect((await run(mw, { realIp: '2001:db8:0:1::1' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '2001:db8:0:2::1' })).status).to.eq(429);
    });

    it('keeps a counter per route, per limit and window, apart from ThrottleMiddleware rules in the same store', async () => {
      const store = new MemoryThrottleStore();
      const login = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60 }, {}, store), '/auth/login');
      const other = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60 }, {}, store), '/auth/other');
      const sameRouteGet = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60 }, {}, store), '/auth/login', { InternalType: 'get' } as unknown as IRoute);
      const hourly = await registered(await makeMiddleware({ limit: 1, windowSeconds: 3600 }, {}, store), '/auth/login');

      for (const mw of [login, other, sameRouteGet, hourly]) expect((await run(mw)).passed).to.eq(true);
      for (const mw of [login, other, sameRouteGet, hourly]) expect((await run(mw)).status).to.eq(429);
      // a ThrottleMiddleware key is `<ip>:<rule path>:<methods>`
      expect(store.increment('1.2.3.4:/auth/login:POST', 60).count).to.eq(1);
    });

    it('hands a counter store failure to the error handler', async () => {
      const broken = { increment: () => Promise.reject(new Error('store down')) } as unknown as ThrottleStore;
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60 }, {}, broken));

      expect(((await run(mw)).error as Error).message).to.eq('store down');
    });
  });

  describe('limiting by principal', () => {
    it('counts per authenticated principal, whatever its address', async () => {
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60, by: 'principal' }));

      expect((await run(mw, { realIp: '1.1.1.1', Principal: user('a') })).passed).to.eq(true);
      expect((await run(mw, { realIp: '2.2.2.2', Principal: user('a') })).status).to.eq(429);
      expect((await run(mw, { realIp: '1.1.1.1', Principal: user('b') })).passed).to.eq(true);
    });

    it('reads the authn principal when no authz principal is set', async () => {
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60, by: 'principal' }));

      expect((await run(mw, { realIp: '1.1.1.1', AuthnPrincipal: user('a') })).passed).to.eq(true);
      expect((await run(mw, { realIp: '2.2.2.2', Principal: user('a') })).status).to.eq(429);
    });

    it('counts an anonymous request per address', async () => {
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60, by: 'principal' }));

      expect((await run(mw, { realIp: '1.1.1.1', Principal: user('anonymous', false) })).passed).to.eq(true);
      expect((await run(mw, { realIp: '1.1.1.1' })).status).to.eq(429);
      expect((await run(mw, { realIp: '2.2.2.2', Principal: user('anonymous', false) })).passed).to.eq(true);
      // an address counter is not the counter of a principal whose id is that address
      expect((await run(mw, { realIp: '3.3.3.3', Principal: { ...user('1.1.1.1'), type: 'ip' } })).passed).to.eq(true);
    });
  });

  describe('on a route', function () {
    this.timeout(15000);
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        configuration: TestConfiguration,
        register: (c) => c.register(RateLimitedController).as(BaseController),
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('answers 429 over the limit through the reply pipeline, a route of its own counter, a route without it unlimited', async () => {
      expect((await req().post('rate-limited/login')).status).to.eq(200);
      const second = await req().post('rate-limited/login');
      expect(second.status).to.eq(200);
      expect(second.header['x-ratelimit-limit']).to.eq('2');
      expect(second.header['x-ratelimit-remaining']).to.eq('0');

      const limited = await req().post('rate-limited/login');
      expect(limited.status).to.eq(429);
      expect(Number(limited.header['retry-after'])).to.be.within(1, 60);
      expect(limited.body).to.deep.eq({ error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } });

      expect((await req().post('rate-limited/other')).status).to.eq(200);
      for (let i = 0; i < 3; i++) {
        const free = await req().get('rate-limited/free');
        expect(free.status).to.eq(200);
        expect(free.header['x-ratelimit-limit']).to.eq(undefined);
      }
    });
  });
});
