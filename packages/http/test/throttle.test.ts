import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { MemoryThrottleStore, ThrottleMiddleware, IThrottleRule, ThrottleStore } from '../src/middlewares/Throttle.js';

interface IFakeResult {
  nextCalled: boolean;
  nextError?: unknown;
  status?: number;
  body?: any;
  headers: Record<string, string>;
}

function makeMiddleware(cfg: { enabled?: boolean; rules?: IThrottleRule[] } | undefined, store?: ThrottleStore) {
  const mw = new ThrottleMiddleware();
  // decorator-injected properties are getter-only; redefine them for the unit test
  Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path === 'http.throttle' ? cfg : def) } });
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

describe('ThrottleMiddleware', () => {
  afterEach(() => {
    sinon.restore();
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
    it('is a no-op when disabled or unconfigured', () => {
      expect(makeMiddleware(undefined).before()).to.be.null;
      expect(makeMiddleware({ enabled: false, rules: [{ path: '/', limit: 1, windowSeconds: 1 }] }).before()).to.be.null;
    });

    it('is a no-op when enabled without valid rules', () => {
      expect(makeMiddleware({ enabled: true, rules: [] }).before()).to.be.null;
      expect(makeMiddleware({ enabled: true, rules: [{ path: '/x', limit: 0, windowSeconds: 60 }] }).before()).to.be.null;
    });
  });

  describe('limiting', () => {
    const RULES: IThrottleRule[] = [{ path: '/auth', methods: ['POST'], limit: 2, windowSeconds: 60 }];

    it('passes requests under the limit and refuses the first one over it with 429', async () => {
      const handler = makeMiddleware({ enabled: true, rules: RULES }).before()!;

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
      const handler = makeMiddleware({ enabled: true, rules: RULES }).before()!;

      await run(handler, request());
      await run(handler, request());
      expect((await run(handler, request())).status).to.eq(429);

      // another address is not affected
      expect((await run(handler, request({ ip: '5.6.7.8' }))).nextCalled).to.eq(true);
    });

    it('ignores paths and methods outside the rules', async () => {
      const handler = makeMiddleware({ enabled: true, rules: RULES }).before()!;

      for (let i = 0; i < 5; i++) {
        expect((await run(handler, request({ path: '/api/users' }))).nextCalled).to.eq(true);
        expect((await run(handler, request({ method: 'GET' }))).nextCalled).to.eq(true);
      }
    });

    it('matches by path prefix', async () => {
      const handler = makeMiddleware({ enabled: true, rules: RULES }).before()!;

      await run(handler, request({ path: '/auth/password/reset-request' }));
      await run(handler, request({ path: '/auth/password/reset-request' }));

      const limited = await run(handler, request({ path: '/auth/password/reset-request' }));
      expect(limited.status).to.eq(429);
    });

    it('lets the request through when the counter store fails', async () => {
      const broken: ThrottleStore = {
        increment: () => Promise.reject(new Error('store down')),
      } as ThrottleStore;
      const handler = makeMiddleware({ enabled: true, rules: RULES }, broken).before()!;

      const result = await run(handler, request());
      expect(result.nextCalled).to.eq(true);
      expect(result.nextError).to.be.instanceOf(Error);
    });
  });
});
