import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import { createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, CONTROLLED_DESCRIPTOR_SYMBOL, Controllers, Get, HttpServer, MemoryThrottleStore, Ok, Post, RateLimit, RateLimitMiddleware, RawJsonResponse, ThrottleMiddleware, ThrottleStore, configuredRateLimit, rateLimitSchema, rateLimitsSchema, resolveRouteMiddlewares } from '../src/index.js';
import type { IController, IControllerDescriptor, IRateLimitOptions, IRoute, IThrottleRule, RateLimitDefaults, RateLimitSchemaOptions } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { globalRouteMiddlewareDescriptors } from '../src/global-route-middlewares.js';

interface IRun {
  passed: boolean;
  error?: unknown;
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  /** The headers the answer carries itself, apart from the ones set on `res`. */
  answerHeaders?: Record<string, string>;
}

const ROUTE = { InternalType: 'post', Method: 'login' } as unknown as IRoute;

const descriptorOf = (type: object) => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, (type as { prototype: object }).prototype) as IControllerDescriptor;
const routeMiddlewaresOf = (type: object, method: string) => descriptorOf(type).Routes.get(method)!.Middlewares;

async function makeMiddleware(options: { limit: number; windowSeconds: number; by?: 'ip' | 'principal' }, config: Record<string, unknown> = {}, store?: ThrottleStore): Promise<RateLimitMiddleware> {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config });
  const mw = readingFrom(new RateLimitMiddleware(options.limit, options.windowSeconds, options.by), container);
  Object.defineProperty(mw, 'Store', { value: store ?? new MemoryThrottleStore() });
  return mw;
}

async function makeObjectMiddleware(options: IRateLimitOptions, config: Record<string, unknown> = {}, store?: ThrottleStore): Promise<RateLimitMiddleware> {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config });
  const mw = readingFrom(new RateLimitMiddleware(options), container);
  Object.defineProperty(mw, 'Store', { value: store ?? new MemoryThrottleStore() });
  Object.defineProperty(mw, 'Configuration', { value: await container.resolve(Configuration) });
  return mw;
}

async function registrationError(mw: RateLimitMiddleware): Promise<Error | undefined> {
  try {
    await mw.onRegister(ROUTE, '/auth/login');
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

const CONTROLLER = {} as IController;

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
      result.answerHeaders = Object.fromEntries(answer.headers.map((h) => [h.Name, String(h.Value)]));
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

  @Post()
  @RateLimit({ limit: 2, windowSeconds: 60, headers: true })
  public opted() {
    return new Ok({ ok: true });
  }

  @Get()
  public free() {
    return new Ok({ ok: true });
  }
}

const uniformAnswer = (retryAfterSeconds: number) => new RawJsonResponse(401, { error: 'uniform' }, { Headers: [{ Name: 'Retry-After', Value: String(retryAfterSeconds) }] });

@BasePath('rate-limited-options')
class RateLimitOptionsController extends BaseController {
  @Post()
  @RateLimit({ config: 'test.rateLimit.tight', default: { limit: 5, windowSeconds: 60 }, answer: uniformAnswer, headers: false })
  public login() {
    return new Ok({ ok: true });
  }

  @Post()
  @RateLimit({ config: 'test.rateLimit.off', default: { limit: 1, windowSeconds: 60 } })
  public unlimited() {
    return new Ok({ ok: true });
  }
}

class RateLimitConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as Record<string, unknown>).test = { rateLimit: { tight: { limit: 1 }, off: false } };
  }
}

@BasePath('rate-limited-off')
@RateLimit(1, 60)
class RateLimitOffController extends BaseController {
  @Post()
  @RateLimit({ config: false })
  public callback() {
    return new Ok({ ok: true });
  }

  @Post()
  public login() {
    return new Ok({ ok: true });
  }

  @Post()
  @RateLimit({ config: false })
  public free() {
    return new Ok({ ok: true });
  }
}

@BasePath('rate-limited-floor')
class RateLimitFloorController extends BaseController {
  @Post()
  @RateLimit({ config: false })
  public callback() {
    return new Ok({ ok: true });
  }

  @Post()
  public other() {
    return new Ok({ ok: true });
  }
}

class RateLimitFloorConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const http = (this.Config as Record<string, Record<string, unknown>>).http;
    http.routes = { ...(http.routes as object), middlewares: [{ service: 'RateLimitMiddleware', options: [1, 60] }] };
  }
}

class BrokenStore extends ThrottleStore {
  public increment(): Promise<never> {
    return Promise.reject(new Error('store down'));
  }
}

@BasePath('rate-limited-broken')
class BrokenStoreController extends BaseController {
  public static calls = 0;

  @Post()
  @RateLimit(5, 60)
  public guarded() {
    BrokenStoreController.calls++;
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

  describe('declared unlimited: { config: false }', () => {
    const enabledLimits = async (type: object, method: string, globals: { Type: typeof RateLimitMiddleware; Options: unknown[] }[]) => {
      const descriptor = descriptorOf(type);
      const route = descriptor.Routes.get(method)!;
      const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: {} });
      const resolved = await resolveRouteMiddlewares(descriptor, route, container, globals);
      return resolved.filter((m) => m instanceof RateLimitMiddleware && m.isEnabled(route, CONTROLLER)).map((m) => (m as RateLimitMiddleware).limit);
    };
    const FLOOR = [{ Type: RateLimitMiddleware, Options: [1, 60] }];

    it('is not mounted and drops the global floor and the controller limit on its route only', async () => {
      expect(await enabledLimits(RateLimitOffController, 'callback', FLOOR)).to.deep.eq([]);
      expect(await enabledLimits(RateLimitOffController, 'login', FLOOR), 'the controller limit replaces the floor').to.deep.eq([1]);
      expect(await enabledLimits(RateLimitFloorController, 'callback', FLOOR)).to.deep.eq([]);
      expect(await enabledLimits(RateLimitFloorController, 'other', FLOOR), 'the floor').to.deep.eq([1]);
    });

    it('takes no other option, and config must be a string or false', async () => {
      expect((await makeObjectMiddleware({ config: false })).isEnabled(ROUTE, CONTROLLER)).to.eq(false);
      for (const options of [{ config: false, limit: 5 }, { config: false, default: { limit: 1, windowSeconds: 1 } }, { config: false, headers: false }, { config: true }] as unknown as IRateLimitOptions[]) {
        const error = await registrationError(await makeObjectMiddleware(options));
        expect(error, JSON.stringify(options)).to.be.instanceOf(InvalidArgument);
      }
    });
  });

  describe('rateLimitSchema', () => {
    it('describes false or settings over the default, refusing unknown and out-of-range settings', () => {
      const schema = rateLimitSchema({ limit: 30, windowSeconds: 60, by: 'ip' }, 'POST /x') as { default: unknown; anyOf: { enum?: unknown[]; propertyNames?: unknown; properties?: Record<string, unknown> }[] };
      expect(schema.default).to.deep.eq({ limit: 30, windowSeconds: 60, by: 'ip' });
      expect(schema.anyOf[0]).to.deep.eq({ enum: [false] });
      expect(schema.anyOf[1].propertyNames).to.deep.eq({ enum: ['limit', 'windowSeconds', 'by', 'headers'] });
      expect(schema.anyOf[1].properties).to.deep.eq({ limit: { type: 'integer', minimum: 0 }, windowSeconds: { type: 'number', exclusiveMinimum: 0 }, by: { enum: ['ip', 'principal'] }, headers: { type: 'boolean' } });
    });

    it('leaves headers out of the accepted keys with { headers: false }', () => {
      const schema = rateLimitSchema({ limit: 30, windowSeconds: 60, by: 'ip' }, 'POST /x', { headers: false }) as { anyOf: { propertyNames?: unknown; properties?: Record<string, unknown> }[] };
      expect(schema.anyOf[1].propertyNames).to.deep.eq({ enum: ['limit', 'windowSeconds', 'by'] });
      expect(schema.anyOf[1].properties).to.not.have.property('headers');
    });
  });

  describe('rateLimitsSchema', () => {
    const defaults = { checks: { limit: 600, windowSeconds: 60, by: 'principal' }, events: { limit: 10, windowSeconds: 60, by: 'principal' } } as const satisfies RateLimitDefaults;
    const routes = { checks: 'POST /authz/checks', events: 'GET /authz/events' };
    type Schema = { default: unknown; propertyNames: unknown; properties: Record<string, unknown>; description: string };

    it('has one entry per name, defaults to {} and refuses unknown names', () => {
      const schema = rateLimitsSchema(defaults, routes) as Schema;
      expect(schema.default).to.deep.equal({});
      expect(schema.propertyNames).to.deep.equal({ enum: ['checks', 'events'] });
      expect(schema.properties.checks).to.deep.equal(rateLimitSchema(defaults.checks, routes.checks));
      expect(schema.properties.events).to.deep.equal(rateLimitSchema(defaults.events, routes.events));
    });

    it('takes a description', () => {
      expect((rateLimitsSchema(defaults, routes, 'Login limits') as Schema).description).to.equal('Login limits');
    });

    it('passes { headers: false } to every entry and leaves headers out of its default description', () => {
      expect((rateLimitsSchema(defaults, routes) as Schema).description).to.contain('{ limit, windowSeconds, by, headers }');
      const schema = rateLimitsSchema(defaults, routes, undefined, { headers: false }) as Schema;
      expect(schema.description).to.contain('{ limit, windowSeconds, by }');
      expect(schema.properties.checks).to.deep.equal(rateLimitSchema(defaults.checks, routes.checks, { headers: false }));
      expect(schema.properties.events).to.deep.equal(rateLimitSchema(defaults.events, routes.events, { headers: false }));
    });
  });

  describe('configuredRateLimit', () => {
    it("declares RateLimitMiddleware with <root>.<name> and that name's default", () => {
      const limit = configuredRateLimit('authz.http.rateLimit', { checks: { limit: 600, windowSeconds: 60, by: 'principal' } });
      const answer = () => new Ok({});
      const key = () => 'k';
      class C {}
      limit('checks', { answer, key })(C.prototype, 'checks', {} as PropertyDescriptor);
      limit('checks')(C.prototype, 'plain', {} as PropertyDescriptor);
      // @ts-expect-error headers of a configured route come from its config, which rateLimitsSchema lets set them
      limit('checks', { headers: false });
      const [mw] = routeMiddlewaresOf(C, 'checks');
      expect(mw.Type).to.eq(RateLimitMiddleware);
      expect(mw.Options).to.deep.eq([{ config: 'authz.http.rateLimit.checks', default: { limit: 600, windowSeconds: 60, by: 'principal' }, answer, key }]);
      expect(routeMiddlewaresOf(C, 'plain')[0].Options).to.deep.eq([{ config: 'authz.http.rateLimit.checks', default: { limit: 600, windowSeconds: 60, by: 'principal' } }]);
    });

    it('keeps its config key and default over options that name them', () => {
      const limit = configuredRateLimit('authz.http.rateLimit', { checks: { limit: 600, windowSeconds: 60, by: 'principal' } });
      class C {}
      limit('checks', { config: 'other.key', default: { limit: 1, windowSeconds: 1 } } as IRateLimitOptions)(C.prototype, 'checks', {} as PropertyDescriptor);
      expect(routeMiddlewaresOf(C, 'checks')[0].Options).to.deep.eq([{ config: 'authz.http.rateLimit.checks', default: { limit: 600, windowSeconds: 60, by: 'principal' } }]);
    });

    it('adds no headers key without opts.headers', () => {
      const limit = configuredRateLimit('authz.http.rateLimit', { checks: { limit: 600, windowSeconds: 60, by: 'principal' } }, { headers: undefined });
      class C {}
      limit('checks')(C.prototype, 'checks', {} as PropertyDescriptor);
      expect(routeMiddlewaresOf(C, 'checks')[0].Options[0]).to.not.have.property('headers');
    });

    it('fixes the headers of every route it declares with { headers: false }', () => {
      const lock: RateLimitSchemaOptions = { headers: false };
      const limit = configuredRateLimit('authn.rateLimit', { login: { limit: 30, windowSeconds: 60, by: 'ip' } }, lock);
      const answer = () => new Ok({});
      class C {}
      limit('login', { answer, headers: true } as IRateLimitOptions)(C.prototype, 'login', {} as PropertyDescriptor);
      expect(routeMiddlewaresOf(C, 'login')[0].Options).to.deep.eq([{ config: 'authn.rateLimit.login', default: { limit: 30, windowSeconds: 60, by: 'ip' }, answer, headers: false }]);
    });
  });

  describe('the options object', () => {
    it('takes inline numbers and counts on the key the positional form uses', async () => {
      const store = new MemoryThrottleStore();
      const increment = sinon.spy(store, 'increment');
      const mw = await registered(await makeObjectMiddleware({ limit: 1, windowSeconds: 60 }, {}, store));

      expect(mw.by).to.eq('ip');
      expect((await run(mw)).passed).to.eq(true);
      const limited = await run(mw);
      expect(limited.status).to.eq(429);
      expect(limited.headers).to.deep.eq({});
      expect(Number(limited.answerHeaders?.['Retry-After'])).to.be.within(1, 60);
      expect(increment.firstCall.args).to.deep.eq(['rate:POST /auth/login:1/60:ip:1.2.3.4', 60]);
    });

    it('reads the numbers from config over the default, the default when the key is unset', async () => {
      const store = new MemoryThrottleStore();
      const increment = sinon.spy(store, 'increment');
      const options = { config: 'http.test.rateLimit.login', default: { limit: 5, windowSeconds: 60 } };
      const configured = await registered(await makeObjectMiddleware(options, { http: { test: { rateLimit: { login: { limit: 1, by: 'principal' } } } } }, store));
      const unset = await registered(await makeObjectMiddleware(options, {}, store));

      expect([configured.limit, configured.windowSeconds, configured.by]).to.deep.eq([1, 60, 'principal']);
      expect([unset.limit, unset.windowSeconds, unset.by]).to.deep.eq([5, 60, 'ip']);
      expect((await run(configured)).passed).to.eq(true);
      expect((await run(configured)).status).to.eq(429);
      // changed numbers count on a key of their own, so a new limit starts a fresh window
      expect(increment.firstCall.args[0]).to.eq('rate:POST /auth/login:1/60:ip:1.2.3.4');
      for (let i = 0; i < 5; i++) expect((await run(unset, { realIp: '5.6.7.8' })).passed, `request ${i + 1}`).to.eq(true);
      expect((await run(unset, { realIp: '5.6.7.8' })).status).to.eq(429);
    });

    it('sends X-RateLimit-* when the config opts in; a configured headers wins over the decorator', async () => {
      const options = { config: 'app.rateLimit.x', default: { limit: 2, windowSeconds: 60 } };
      const optedIn = await registered(await makeObjectMiddleware(options, { app: { rateLimit: { x: { headers: true } } } }));
      expect((await run(optedIn)).headers['X-RateLimit-Limit']).to.eq('2');

      const optedOut = await registered(await makeObjectMiddleware({ ...options, headers: true }, { app: { rateLimit: { x: { headers: false } } } }));
      expect(await run(optedOut)).to.deep.eq({ passed: true, headers: {} });
      await run(optedOut);
      const limited = await run(optedOut);
      expect(limited.headers).to.deep.eq({});
      expect(Object.keys(limited.answerHeaders ?? {})).to.deep.eq(['Retry-After']);

      const decorated = await registered(await makeObjectMiddleware({ ...options, headers: true }));
      expect((await run(decorated)).headers['X-RateLimit-Limit']).to.eq('2');
    });

    it('refuses a configured headers that is not a boolean, or under a decorator with headers: false', async () => {
      const options = { config: 'app.rateLimit.x', default: { limit: 2, windowSeconds: 60 } };
      const notBoolean = await registrationError(await makeObjectMiddleware(options, { app: { rateLimit: { x: { headers: 'yes' } } } }));
      expect(notBoolean).to.be.instanceOf(InvalidOption);
      expect(notBoolean?.message).to.contain('app.rateLimit.x.headers');

      const locked = await registrationError(await makeObjectMiddleware({ ...options, headers: false }, { app: { rateLimit: { x: { headers: true } } } }));
      expect(locked).to.be.instanceOf(InvalidOption);
      expect(locked?.message).to.contain('app.rateLimit.x has unknown keys headers');

      const lockedDefault = await registrationError(await makeObjectMiddleware({ config: 'app.rateLimit.x', default: { limit: 2, windowSeconds: 60, headers: true }, headers: false }));
      expect(lockedDefault).to.be.instanceOf(InvalidArgument);
      expect(lockedDefault?.message).to.contain('@RateLimit default has unknown keys headers');
    });

    it('ranks default.headers as the config value: it wins over the decorator headers, and headers: false refuses it', async () => {
      const inlineOff = await registered(await makeObjectMiddleware({ default: { limit: 2, windowSeconds: 60, headers: false }, headers: true }));
      expect(await run(inlineOff)).to.deep.eq({ passed: true, headers: {} });

      const configuredOff = await registered(await makeObjectMiddleware({ config: 'app.rateLimit.x', default: { limit: 2, windowSeconds: 60, headers: false }, headers: true }));
      expect(await run(configuredOff)).to.deep.eq({ passed: true, headers: {} });

      const inlineOn = await registered(await makeObjectMiddleware({ default: { limit: 2, windowSeconds: 60, headers: true } }));
      expect((await run(inlineOn)).headers['X-RateLimit-Limit']).to.eq('2');

      const locked = await registrationError(await makeObjectMiddleware({ default: { limit: 2, windowSeconds: 60, headers: true }, headers: false }));
      expect(locked).to.be.instanceOf(InvalidArgument);
      expect(locked?.message).to.contain('@RateLimit default has unknown keys headers');
    });

    it('is not mounted when the config key is false, and does nothing if registered anyway', async () => {
      const store = new MemoryThrottleStore();
      const increment = sinon.spy(store, 'increment');
      const mw = await makeObjectMiddleware({ config: 'http.test.rateLimit.login', default: { limit: 1, windowSeconds: 60 } }, { http: { test: { rateLimit: { login: false } } } }, store);

      expect(mw.isEnabled(ROUTE, CONTROLLER)).to.eq(false);
      await mw.onRegister(ROUTE, '/auth/login');
      for (let i = 0; i < 3; i++) expect(await run(mw)).to.deep.eq({ passed: true, headers: {} });
      expect(increment.called).to.eq(false);
    });

    it('refuses a config value it cannot enforce with InvalidOption naming the key', async () => {
      const bad: [unknown, string][] = [
        [{ limit: 'x' }, 'http.test.rateLimit.login.limit'],
        [{ limit: -1 }, 'http.test.rateLimit.login.limit'],
        [{ windowSeconds: 0 }, 'http.test.rateLimit.login.windowSeconds'],
        [{ by: 'session' }, 'http.test.rateLimit.login.by'],
        [{ limt: 1 }, 'http.test.rateLimit.login'],
        [5, 'http.test.rateLimit.login'],
        [true, 'http.test.rateLimit.login'],
      ];
      for (const [value, key] of bad) {
        const mw = await makeObjectMiddleware({ config: 'http.test.rateLimit.login', default: { limit: 1, windowSeconds: 60 } }, { http: { test: { rateLimit: { login: value } } } });
        expect(mw.isEnabled(ROUTE, CONTROLLER), JSON.stringify(value)).to.eq(true);
        const error = await registrationError(mw);
        expect(error, JSON.stringify(value)).to.be.instanceOf(InvalidOption);
        expect(error?.message, JSON.stringify(value)).to.contain(key);
      }
    });

    it('refuses options it cannot enforce with InvalidArgument', async () => {
      const bad: [IRateLimitOptions, string][] = [
        [{ config: 'http.test.rateLimit.login' }, 'default'],
        [{ config: 'http.test.rateLimit.login', default: { limit: 1, windowSeconds: 0 } }, 'windowSeconds'],
        [{ limit: 1 }, 'windowSeconds'],
        [{ windowSeconds: 60 }, 'limit'],
        [{ limit: 1, windowSeconds: 60, by: 'session' as 'ip' }, 'by'],
        [{ limit: 1, windowSeconds: 60, answer: 'x' as never }, 'answer'],
        [{ limit: 1, windowSeconds: 60, key: 1 as never }, 'key'],
        [{ limit: 1, windowSeconds: 60, headers: 'false' as never }, 'headers'],
        [{ default: { limit: 1, windowSeconds: 60, headers: 'yes' as never } }, '@RateLimit default.headers'],
        [{ limit: 1, windowSeconds: 60, header: false } as IRateLimitOptions, 'header'],
        [{ config: '', default: { limit: 1, windowSeconds: 60 } }, 'config'],
        [{ config: 'http.test.rateLimit.login', default: { limit: 1, windowSeconds: 60, limt: 2 } as never }, 'limt'],
      ];
      for (const [options, name] of bad) {
        const error = await registrationError(await makeObjectMiddleware(options));
        expect(error, JSON.stringify(options)).to.be.instanceOf(InvalidArgument);
        expect(error?.message, JSON.stringify(options)).to.contain(name);
      }
    });

    it('fails closed when a subclass skips super.onRegister', async () => {
      class Forgetful extends RateLimitMiddleware {
        public override onRegister(): void {}
      }
      const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: {} });
      const mw = readingFrom(new Forgetful(1, 60), container);
      Object.defineProperty(mw, 'Store', { value: new MemoryThrottleStore() });

      expect(mw.isEnabled(ROUTE, CONTROLLER)).to.eq(true);
      mw.onRegister();
      for (let i = 0; i < 2; i++) expect(((await run(mw)).error as Error)?.message).to.contain('super.onRegister');
    });

    it('answers with `answer` and, with headers: false, sets no X-RateLimit-* and no Retry-After of its own', async () => {
      const answer = sinon.spy(uniformAnswer);
      const mw = await registered(await makeObjectMiddleware({ limit: 1, windowSeconds: 60, answer, headers: false }));

      expect(await run(mw)).to.deep.eq({ passed: true, headers: {} });
      const limited = await run(mw);
      expect(limited.headers).to.deep.eq({});
      expect(limited.status).to.eq(401);
      expect(limited.body).to.deep.eq({ error: 'uniform' });
      expect(answer.calledOnce).to.eq(true);
      expect(answer.firstCall.args[0]).to.be.within(1, 60);
      expect(answer.firstCall.returnValue.headers).to.deep.eq([{ Name: 'Retry-After', Value: String(answer.firstCall.args[0]) }]);
    });

    it('with an answer, sets X-RateLimit-* and Retry-After of its own only under headers: true', async () => {
      const quiet = await registered(await makeObjectMiddleware({ limit: 1, windowSeconds: 60, answer: uniformAnswer }));
      await run(quiet);
      const unset = await run(quiet);
      expect(unset.status).to.eq(401);
      expect(unset.headers).to.deep.eq({});

      const mw = await registered(await makeObjectMiddleware({ limit: 1, windowSeconds: 60, answer: uniformAnswer, headers: true }));
      await run(mw);
      const limited = await run(mw);
      expect(limited.status).to.eq(401);
      expect(limited.headers['X-RateLimit-Limit']).to.eq('1');
      expect(Number(limited.headers['Retry-After'])).to.be.within(1, 60);
    });

    it('with headers: false and no answer, answers the 429 that carries its own Retry-After', async () => {
      const mw = await registered(await makeObjectMiddleware({ limit: 1, windowSeconds: 60, headers: false }));

      await run(mw);
      const res = { set: sinon.spy() };
      const limited = await mw.onBefore({ req: { socket: {} } as never, res: res as never, storage: { realIp: '1.2.3.4' } as never });
      expect(res.set.called).to.eq(false);
      expect(limited!.statusCode).to.eq(429);
      expect(JSON.stringify(limited!.data)).to.eq(JSON.stringify({ error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } }));
      expect(Number(limited!.headers.find((h) => h.Name === 'Retry-After')?.Value)).to.be.within(1, 60);
    });

    it('answers a closed route (limit 0) with `answer`, counting nothing', async () => {
      const store = new MemoryThrottleStore();
      const increment = sinon.spy(store, 'increment');
      const mw = await registered(await makeObjectMiddleware({ limit: 0, windowSeconds: 60, answer: uniformAnswer, headers: false }, {}, store));

      const closed = await run(mw);
      expect(closed.status).to.eq(401);
      expect(closed.headers).to.deep.eq({});
      expect(increment.called).to.eq(false);
    });

    it('counts on the key(ctx) of the request, under the route key, and falls back to `by` when it gives none', async () => {
      const store = new MemoryThrottleStore();
      const increment = sinon.spy(store, 'increment');
      const key = sinon.spy((ctx: { storage: { session?: string } }) => ctx.storage.session);
      const mw = await registered(await makeObjectMiddleware({ limit: 1, windowSeconds: 60, key: key as unknown as IRateLimitOptions['key'] }, {}, store));

      expect((await run(mw, { realIp: '1.1.1.1', session: 's1' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '2.2.2.2', session: 's1' })).status).to.eq(429);
      expect((await run(mw, { realIp: '1.1.1.1', session: 's2' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '1.1.1.1' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '1.1.1.1' })).status).to.eq(429);
      // a key that looks like an address subject is still not that address's counter
      expect((await run(mw, { realIp: '3.3.3.3', session: 'ip:4.4.4.4' })).passed).to.eq(true);
      expect((await run(mw, { realIp: '4.4.4.4' })).passed).to.eq(true);

      expect(increment.firstCall.args[0]).to.eq('rate:POST /auth/login:1/60:key:s1');
      expect(key.firstCall.args[0]).to.have.keys('req', 'res', 'storage');
    });
  });

  describe('limiting by ip', () => {
    it('passes requests under the limit and answers the first one over it with the 429 ThrottleMiddleware sends', async () => {
      const mw = await registered(await makeMiddleware({ limit: 2, windowSeconds: 60 }));

      expect(await run(mw)).to.deep.eq({ passed: true, headers: {} });
      expect((await run(mw)).passed).to.eq(true);

      const limited = await run(mw);
      expect(limited.passed).to.eq(false);
      expect(limited.status).to.eq(429);
      expect(limited.headers).to.deep.eq({});
      expect(Object.keys(limited.answerHeaders ?? {})).to.deep.eq(['Retry-After']);
      expect(Number(limited.answerHeaders?.['Retry-After'])).to.be.within(1, 60);

      const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { throttle: { enabled: true, rules: [{ path: '/', limit: 1, windowSeconds: 60 }] as IThrottleRule[] } } } });
      const throttle = readingFrom(new ThrottleMiddleware(), container);
      Object.defineProperty(throttle, 'Store', { value: { increment: () => ({ count: 2, resetAt: Date.now() + 60_000 }) } });
      Object.defineProperty(throttle, 'Log', { value: { warn: sinon.stub() } });
      const throttled = await throttle.onBefore({ req: { path: '/x', method: 'GET', socket: {} } as never, res: { set: () => undefined } as never, storage: { realIp: '1.2.3.4' } as never });
      expect(JSON.stringify(limited.body)).to.eq(JSON.stringify((await throttled)!.data));
    });

    it('with headers: true, sets X-RateLimit-* on every counted request and Retry-After on the 429', async () => {
      const mw = await registered(await makeObjectMiddleware({ limit: 2, windowSeconds: 60, headers: true }));

      const first = await run(mw);
      expect(first.passed).to.eq(true);
      expect(first.headers['X-RateLimit-Limit']).to.eq('2');
      expect(first.headers['X-RateLimit-Remaining']).to.eq('1');
      expect(Number(first.headers['X-RateLimit-Reset'])).to.be.greaterThan(Date.now() / 1000);
      await run(mw);

      const limited = await run(mw);
      expect(limited.status).to.eq(429);
      expect(limited.headers['X-RateLimit-Remaining']).to.eq('0');
      expect(Number(limited.headers['Retry-After'])).to.be.within(1, 60);
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

    it('closes the route with a limit of 0: 429 without a Retry-After or reset, and no store write', async () => {
      const store = new MemoryThrottleStore();
      const increment = sinon.spy(store, 'increment');
      const mw = await registered(await makeMiddleware({ limit: 0, windowSeconds: 60 }, {}, store));

      const closed = await run(mw);
      expect(closed.status).to.eq(429);
      expect(closed.headers).to.deep.eq({});
      expect(closed.answerHeaders).to.deep.eq({});
      expect(JSON.stringify(closed.body)).to.eq(JSON.stringify({ error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } }));
      expect(increment.called).to.eq(false);

      const optedIn = await registered(await makeObjectMiddleware({ limit: 0, windowSeconds: 60, headers: true }, {}, store));
      expect((await run(optedIn)).headers).to.deep.eq({ 'X-RateLimit-Limit': '0', 'X-RateLimit-Remaining': '0' });
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

    it('keeps principals apart whose type and id differ only in where a colon falls', async () => {
      const mw = await registered(await makeMiddleware({ limit: 1, windowSeconds: 60, by: 'principal' }));

      expect((await run(mw, { Principal: { ...user('b:c'), type: 'a' } })).passed).to.eq(true);
      expect((await run(mw, { Principal: { ...user('c'), type: 'a:b' } })).passed).to.eq(true);
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

    it('answers 429 over the limit through the reply pipeline, a route of its own counter, a route without it unlimited, X-RateLimit-* only on a route that opts in', async () => {
      const first = await req().post('rate-limited/login');
      expect(first.status).to.eq(200);
      expect(first.header['x-ratelimit-limit']).to.eq(undefined);
      expect((await req().post('rate-limited/login')).status).to.eq(200);

      const limited = await req().post('rate-limited/login');
      expect(limited.status).to.eq(429);
      expect(Number(limited.header['retry-after'])).to.be.within(1, 60);
      expect(Object.keys(limited.header).filter((h) => h.startsWith('x-ratelimit-'))).to.deep.eq([]);
      expect(limited.body).to.deep.eq({ error: { code: 'E_TOO_MANY_REQUESTS', message: 'Too many requests, try again later' } });

      expect((await req().post('rate-limited/other')).status).to.eq(200);
      for (let i = 0; i < 3; i++) {
        const free = await req().get('rate-limited/free');
        expect(free.status).to.eq(200);
        expect(free.header['x-ratelimit-limit']).to.eq(undefined);
      }

      // the suite's afterEach disposes the app, so the route that opts in is checked here
      const opted = await req().post('rate-limited/opted');
      expect(opted.status).to.eq(200);
      expect(opted.header['x-ratelimit-limit']).to.eq('2');
      expect(opted.header['x-ratelimit-remaining']).to.eq('1');
      expect((await req().post('rate-limited/opted')).header['x-ratelimit-remaining']).to.eq('0');

      const optedLimited = await req().post('rate-limited/opted');
      expect(optedLimited.status).to.eq(429);
      expect(Number(optedLimited.header['retry-after'])).to.be.within(1, 60);
      expect(optedLimited.header['x-ratelimit-limit']).to.eq('2');
      expect(optedLimited.header['x-ratelimit-remaining']).to.eq('0');
    });
  });

  describe('the options object on a route', function () {
    this.timeout(15000);
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        configuration: RateLimitConfiguration,
        register: (c) => c.register(RateLimitOptionsController).as(BaseController),
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('limits by the configured numbers with the route answer and no X-RateLimit-* headers; a config false mounts nothing', async () => {
      const first = await req().post('rate-limited-options/login');
      expect(first.status).to.eq(200);
      expect(first.header['x-ratelimit-limit']).to.eq(undefined);

      const limited = await req().post('rate-limited-options/login');
      expect(limited.status).to.eq(401);
      expect(limited.body).to.deep.eq({ error: 'uniform' });
      expect(Number(limited.header['retry-after'])).to.be.within(1, 60);
      expect(limited.header['x-ratelimit-limit']).to.eq(undefined);
      expect(limited.header['x-ratelimit-remaining']).to.eq(undefined);

      // the suite's afterEach disposes the app, so the route whose config key is false is checked here
      for (let i = 0; i < 3; i++) {
        const res = await req().post('rate-limited-options/unlimited');
        expect(res.status).to.eq(200);
        expect(res.header['x-ratelimit-limit']).to.eq(undefined);
      }
    });
  });

  describe('declared unlimited on a route, under a global floor and a controller limit', function () {
    this.timeout(15000);
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        configuration: RateLimitFloorConfiguration,
        register: (c) => {
          c.register(RateLimitOffController).as(BaseController);
          c.register(RateLimitFloorController).as(BaseController);
        },
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('a route with { config: false } is never limited; its neighbours keep the floor or the controller limit', async () => {
      for (const path of ['rate-limited-off/callback', 'rate-limited-off/free', 'rate-limited-floor/callback']) {
        for (let i = 0; i < 3; i++) {
          const res = await req().post(path);
          expect(res.status, `${path} ${i + 1}`).to.eq(200);
          expect(res.header['x-ratelimit-limit']).to.eq(undefined);
        }
      }
      for (const path of ['rate-limited-off/login', 'rate-limited-floor/other']) {
        expect((await req().post(path)).status, path).to.eq(200);
        expect((await req().post(path)).status, path).to.eq(429);
      }
    });
  });

  describe('on a route whose counter store fails', function () {
    this.timeout(15000);
    let app: TestApp;

    before(async () => {
      app = await httpApp({
        configuration: TestConfiguration,
        register: (c) => {
          c.register(BrokenStore).as(ThrottleStore);
          c.register(BrokenStoreController).as(BaseController);
        },
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    });

    after(async () => {
      await app.dispose();
    });

    it('answers the error reply and never runs the action (fail closed)', async () => {
      const res = await req().post('rate-limited-broken/guarded');
      expect(res.status).to.eq(500);
      expect(res.header['x-ratelimit-limit']).to.eq(undefined);
      expect(BrokenStoreController.calls).to.eq(0);
    });
  });
});
