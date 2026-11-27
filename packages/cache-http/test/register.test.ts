import 'mocha';
import { expect } from 'chai';
import { CacheConfigError } from '@spinajs/cache';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, CacheControl, Get, Middleware, Ok, RouteMiddleware, RouteType } from '@spinajs/http';
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

const route = (type: RouteType, middlewares: IMiddlewareDescriptor[]): IRoute => ({
  InternalType: type,
  Type: type,
  Method: 'list',
  Path: 'list',
  Parameters: new Map<number, IRouteParameter>(),
  Middlewares: middlewares,
  Policies: [],
  Options: null,
  Schema: null,
});

const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (err: unknown) => err);

describe('ResponseCacheMiddleware registration', () => {
  let app: TestApp;

  before(async () => {
    app = await createTestApp({ config: { logger: SILENT_LOGGER } });
  });

  after(async () => {
    await app?.dispose();
  });

  const mount = async (options: ResponseCacheOptions, type: RouteType, before: IMiddlewareDescriptor[] = [], after: IMiddlewareDescriptor[] = [], controller: IController = new Plain()): Promise<void> => {
    const resolved = resolveResponseCacheOptions(options);
    const middleware = await app.container.resolve(ResponseCacheMiddleware, [resolved]);
    await middleware.onRegister(route(type, [...before, { Type: ResponseCacheMiddleware, Options: [resolved] }, ...after]), '/items/list', controller);
  };

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
