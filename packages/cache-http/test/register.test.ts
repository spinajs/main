import 'mocha';
import { expect } from 'chai';
import { CacheConfigError } from '@spinajs/cache';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, CacheControl, Get, Middleware, Ok, ParameterType, RouteMiddleware, RouteType } from '@spinajs/http';
import type { IController, IMiddlewareDescriptor, IRoute, IRouteParameter } from '@spinajs/http';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { ResponseCache, ResponseCacheMiddleware, resolveResponseCacheOptions } from '../src/index.js';
import type { ResponseCacheOptions } from '../src/index.js';
import { SILENT_LOGGER } from './support/server.js';

/** Declares what authz-http's AuthzFieldsMiddleware declares: its reply is shaped for the caller. */
class PerCallerFilter extends RouteMiddleware {
  public static readonly PerPrincipalReply = true;
}

@BasePath('items')
class Plain extends BaseController {}

@BasePath('items')
@Middleware(PerCallerFilter)
class Filtered extends BaseController {}

const SHARED = { ttl: '1m', scope: 'shared', sharedBecause: 'the test reply is public' } as const;

const route = (type: RouteType, middlewares: IMiddlewareDescriptor[], parameters: IRouteParameter[] = []): IRoute => ({
  InternalType: type,
  Type: type,
  Method: 'list',
  Path: 'list',
  Parameters: new Map(parameters.map((p) => [p.Index, p])),
  Middlewares: middlewares,
  Policies: [],
  Options: null,
  Schema: null,
});

const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (err: unknown) => err);

/** A route argument as http's parameter decorators record it; `@Header('x-secret')` gives the options `{ key: 'x-secret' }`. */
const arg = (Type: string, Name: string, Options: object = {}): IRouteParameter => ({ Index: 0, Type, Name, Options, RuntimeType: String });

describe('ResponseCacheMiddleware registration', () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp({ config: { logger: SILENT_LOGGER } });
  });

  after(async () => {
    await app?.dispose();
  });

  const mount = async (options: ResponseCacheOptions, type: RouteType, before: IMiddlewareDescriptor[] = [], after: IMiddlewareDescriptor[] = [], controller: IController = new Plain(), parameters: IRouteParameter[] = []): Promise<void> => {
    const resolved = resolveResponseCacheOptions(options);
    const middleware = await app.container.resolve(ResponseCacheMiddleware, [resolved]);
    await middleware.onRegister(route(type, [...before, { Type: ResponseCacheMiddleware, Options: [resolved] }, ...after], parameters), '/items/list', controller);
  };
  const reading = (options: ResponseCacheOptions, ...parameters: IRouteParameter[]): Promise<void> => mount(options, RouteType.GET, [], [], new Plain(), parameters);

  it('mounts on a GET route with CacheControl entered before it, and on a HEAD route', async () => {
    await mount({ ttl: '1m' }, RouteType.GET, [{ Type: CacheControl, Options: [60] }]);
    await mount({ ttl: '1m' }, RouteType.HEAD);
  });

  it('refuses a route of another method', async () => {
    const err = await rejection(mount({ ttl: '1m' }, RouteType.POST));
    expect(err).to.be.instanceOf(InvalidArgument);
    expect((err as Error).message).to.eq('@ResponseCache caches GET and HEAD routes, not a POST route');
  });

  it('refuses options that did not pass @ResponseCache, naming the route', async () => {
    // a scope typo, and a shared scope without sharedBecause: both would share one caller's reply
    for (const raw of [{ ttl: '1m', scope: 'Principal', vary: [], tags: [], cache: 'default' }, { ttl: '1m', scope: 'shared', vary: [], tags: [], cache: 'default' }]) {
      const middleware = await app.container.resolve(ResponseCacheMiddleware, [raw]);
      const err = await rejection(middleware.onRegister(route(RouteType.GET, []), '/items/list', new Plain()));
      expect(err).to.be.instanceOf(InvalidArgument);
      expect((err as Error).message).to.contain('GET /items/list: ResponseCacheMiddleware is mounted by @ResponseCache(), not by @Middleware()');
    }
  });

  it('refuses a CacheControl mounted after it, which a stored reply would never pass', async () => {
    const err = await rejection(mount({ ttl: '1m' }, RouteType.GET, [], [{ Type: CacheControl, Options: [60] }]));
    expect(err).to.be.instanceOf(InvalidArgument);
    expect((err as Error).message).to.contain('is mounted after @ResponseCache');
  });

  it('refuses a cache the configuration does not have', async () => {
    expect(await rejection(mount({ ttl: '1m', cache: 'replies' }, RouteType.GET))).to.be.instanceOf(CacheConfigError);
  });

  it('refuses a tenant or shared scope where the route or its controller shapes the reply per principal', async () => {
    const filter: IMiddlewareDescriptor = { Type: PerCallerFilter, Options: [] };
    for (const scope of ['tenant', 'shared'] as const) {
      for (const err of [await rejection(mount({ ...SHARED, scope }, RouteType.GET, [filter])), await rejection(mount({ ...SHARED, scope }, RouteType.GET, [], [filter]))]) {
        expect(err).to.be.instanceOf(InvalidArgument);
        expect((err as Error).message).to.contain(`scope '${scope}' would give one caller's reply to others, but PerCallerFilter shapes the reply per principal`);
      }
    }
    expect(await rejection(mount(SHARED, RouteType.GET, [], [], new Filtered()))).to.be.instanceOf(InvalidArgument);
  });

  it('caches such a route per principal, and shares a route without it', async () => {
    await mount({ ttl: '1m' }, RouteType.GET, [{ Type: PerCallerFilter, Options: [] }]);
    await mount({ ttl: '1m' }, RouteType.GET, [], [], new Filtered());
    await mount(SHARED, RouteType.GET);
  });

  it('refuses a tenant or shared scope on a route that reads a request input the key does not hold', async () => {
    const refused: [IRouteParameter, string][] = [[arg(ParameterType.FromHeader, 'secret', { key: 'X-Secret' }), 'the header x-secret'], [arg(ParameterType.FromHeader, 'xRegion', { key: undefined }), 'the header xregion'], [arg(ParameterType.FromCookie, 'sid'), 'the header cookie'], [arg(ParameterType.UserAgent, 'agent'), 'the header user-agent'], [arg(ParameterType.Referer, 'from'), 'the header referer'], ...[ParameterType.FromSession, ParameterType.Headers, ParameterType.Ip, ParameterType.RequestId, ParameterType.FromBody, 'CurrentPrincipalArg', 'CurrentUserArg', 'AuthnSessionDataArg'].map((type): [IRouteParameter, string] => [arg(type, 'value'), `the argument value of type '${type}'`])];
    for (const [param, what] of refused) {
      const err = await rejection(reading(SHARED, param));
      expect(err, what).to.be.instanceOf(InvalidArgument);
      const hint = what.startsWith('the header') ? ', or name the header in vary' : ', or read the value from the URL';
      expect((err as Error).message).to.eq(`GET /items/list: @ResponseCache scope 'shared' would give one caller's reply to others, but the route reads ${what}, which is not in the key: cache it with scope 'principal'${hint}`);
    }
    // per principal the key holds the caller: the same arguments mount
    for (const [param] of refused) await reading({ ttl: '1m' }, param);
  });

  it('shares a route whose arguments come from the URL, the container, Accept or a header in vary', async () => {
    await reading({ ...SHARED, vary: ['X-Region', 'user-agent', 'Cookie'] }, ...[ParameterType.FromQuery, ParameterType.QueryField, ParameterType.FromParams, ParameterType.ParamField, ParameterType.FromDi, ParameterType.RequestType, ParameterType.UserAgent, ParameterType.FromCookie].map((type, Index) => ({ ...arg(type, `a${Index}`), Index })), { ...arg(ParameterType.FromHeader, 'xRegion', { key: 'x-region' }), Index: 8 }, { ...arg(ParameterType.FromHeader, 'accept', { key: undefined }), Index: 9 }, { ...arg(ParameterType.FromHeader, 'transform', { key: 'X-Data-Transform' }), Index: 10 });
  });

  it('names the route in an option it refuses at import', () => {
    const declare = (): unknown => {
      class Prices extends BaseController {
        @Get('prices')
        @ResponseCache({ ttl: '1m', scope: 'shared' })
        public prices() {
          return new Ok({});
        }
      }
      return Prices;
    };
    expect(declare).to.throw(InvalidArgument, "Prices.prices: @ResponseCache scope 'shared' gives one stored reply to many callers");
  });
});
