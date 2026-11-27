import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CacheScope, CacheStore, cache } from '@spinajs/cache';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, CacheControl, DataTransformer, Get, HTTP_STATUS_CODE, IdempotencyScopePart, Middleware, Ok, Policy, Req, RouteMiddleware } from '@spinajs/http';
import type { IActionLocalStoregeContext, IRoute, Request } from '@spinajs/http';
import { ResponseCache, ResponseCacheKeyPart, responseCacheKey, responseCacheNamespace } from '../src/index.js';
import { cacheWarnings, run, runs, useServer } from './support/server.js';

const PUBLIC = 'the test reply is the same for every caller';

// the helper of the built key.test.ts
const store = (values: Record<string, unknown>): IActionLocalStoregeContext => ({ requestId: 'r1', responseStart: new Date(0), responseEnd: new Date(0), responseTime: 0, realIp: undefined, ...values });

/** The request store HeaderStore gives a request with `x-user`, without language or tenant. */
const signedIn = (user: string): IActionLocalStoregeContext => store({ Principal: { type: 'user', id: user, authenticated: true, source: 'test', attributes: {} } });

const failsOn = (part: string): boolean => {
  const ambient: unknown = DI.resolve(AsyncLocalStorage).getStore();
  return typeof ambient === 'object' && ambient !== null && Reflect.get(ambient, 'Fail') === part;
};

/** An inner route middleware with a hook, which a stored reply would skip if it were mounted after the cache. */
class Stamp extends RouteMiddleware {
  public onBefore(): void {
    run('stamp');
  }
}

/** Shapes the body for the caller, as authz-http's AuthzFieldTransformer does for `x-data-transform: authz-fields`. */
class PerCallerView extends DataTransformer {
  public static readonly PerPrincipalReply = true;

  public get Type(): string {
    return 'per-caller';
  }

  public transform(data: unknown, request: Request): unknown {
    return { data, for: request.headers['x-user'] };
  }
}

/** A global route middleware that shapes the reply per caller, on one route: onRegister never sees it, the first request must. */
class GlobalShaper extends RouteMiddleware {
  public static readonly PerPrincipalReply = true;

  public isEnabled(route: IRoute): boolean {
    return route.Method === 'redacted';
  }
}

class DenyOnHeader extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public execute(req: Request): Promise<void> {
    return req.headers['x-deny'] === undefined ? Promise.resolve() : Promise.reject(new Forbidden('denied'));
  }
}

/** The tenant of a test request, as tenancy-http's TenantIdempotencyScope gives it. */
class HeaderTenantPart extends IdempotencyScopePart {
  public partOf(store: object): string | undefined {
    const tenant: unknown = Reflect.get(store, 'TestTenant');
    return typeof tenant === 'string' ? `tenant:${tenant}` : undefined;
  }
}

/** An application's key part whose read fails for a flagged request. */
class FailingKeyPart extends ResponseCacheKeyPart {
  public partOf(storage: IActionLocalStoregeContext): string | undefined {
    if (Reflect.get(storage, 'Fail') === 'key') throw new Error('the key part failed');
    return undefined;
  }
}

/**
 * Reads the ambient store, as the tenant CacheScope of CA5 does: "do not cache here" for a flagged request; a store that
 * fails for another flag.
 */
class FlagScope extends CacheScope {
  public segments(): readonly string[] | null {
    if (failsOn('scope')) throw new Error('the cache scope failed');
    const ambient: unknown = DI.resolve(AsyncLocalStorage).getStore();
    return typeof ambient === 'object' && ambient !== null && Reflect.get(ambient, 'NoCache') === true ? null : [];
  }
}

/** Never answers a read, as a store with an offline queue does while it reconnects; the cache `hung` uses it. */
class HangingStore extends CacheStore {
  public get(): Promise<undefined> {
    return new Promise(() => undefined);
  }

  public set(): Promise<void> {
    return Promise.resolve();
  }

  public delete(): Promise<void> {
    return Promise.resolve();
  }

  public versions(tags: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(tags.map(() => 'v1'));
  }

  public bump(): Promise<void> {
    return Promise.resolve();
  }
}

@BasePath('items')
class Items extends BaseController {
  @Get('hung')
  @ResponseCache({ ttl: '1m', cache: 'hung' })
  public hung() {
    return new Ok({ run: run('hung') });
  }

  @Get('raw')
  @ResponseCache({ ttl: '1m', scope: 'shared', sharedBecause: PUBLIC })
  public raw(@Req() req: Request) {
    return new Ok({ run: run('raw'), method: req.method });
  }

  @Get('list')
  @ResponseCache({ ttl: '1m', tags: ['any:item'] })
  @Middleware(CacheControl, 60)
  @Policy(DenyOnHeader)
  public list() {
    return new Ok({ run: run('list') });
  }

  @Get('shared')
  @ResponseCache({ ttl: '1m', scope: 'shared', sharedBecause: PUBLIC, vary: ['X-Region'] })
  public shared() {
    return new Ok({ run: run('shared') });
  }

  @Get('stamped')
  @Middleware(Stamp) // above: mounted after the cache
  @ResponseCache({ ttl: '1m' })
  public stamped() {
    return new Ok({ run: run('stamped') });
  }

  @Get('accepted')
  @ResponseCache({ ttl: '1m' })
  public accepted() {
    return new Ok({ run: run('accepted') }, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  @Get('cookie')
  @ResponseCache({ ttl: '1m' })
  public cookie() {
    return new Ok({ run: run('cookie') }, { Headers: [{ Name: 'Set-Cookie', Value: 'seen=1' }] });
  }

  @Get('nostore')
  @ResponseCache({ ttl: '1m' })
  public nostore() {
    return new Ok({ run: run('nostore') }, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  @Get('failing')
  @ResponseCache({ ttl: '1m' })
  public failing(): never {
    run('failing');
    throw new Error('boom');
  }

  @Get('personal')
  @ResponseCache({ ttl: '1m', scope: 'shared', sharedBecause: PUBLIC })
  @Middleware(CacheControl, 60)
  public personal() {
    return new Ok({ run: run('personal') });
  }

  @Get('view')
  @ResponseCache({ ttl: '1m', scope: 'shared', sharedBecause: PUBLIC })
  public view() {
    return new Ok({ run: run('view') });
  }

  @Get('redacted')
  @ResponseCache({ ttl: '1m', scope: 'shared', sharedBecause: PUBLIC })
  public redacted() {
    return new Ok({ run: run('redacted') });
  }
}

describe('@ResponseCache', function () {
  this.timeout(60000);

  const { server, send, get } = useServer(
    [Items],
    (c: IContainer) => {
      c.register(HeaderTenantPart).as(IdempotencyScopePart);
      c.register(FailingKeyPart).as(ResponseCacheKeyPart);
      c.register(FlagScope).as(CacheScope);
      c.register(PerCallerView).as(DataTransformer);
      c.register(GlobalShaper).as(RouteMiddleware);
      c.register(HangingStore).as(CacheStore);
    },
    ['GlobalShaper'],
  );

  it('answers a repeated GET from the store; the policy and CacheControl still run on the hit', async () => {
    const first = await get('/items/list', { 'x-user': 'ann' });
    const second = await get('/items/list', { 'x-user': 'ann' });

    expect([first.status, first.body, second.status, second.body]).to.deep.eq([200, { run: 1 }, 200, { run: 1 }]);
    expect(String(second.headers['content-type'])).to.match(/^application\/json/);
    expect(second.headers['cache-control']).to.eq('max-age=60');
    expect(second.headers['idempotent-replayed']).to.eq(undefined);
    expect((await get('/items/list', { 'x-user': 'ann', 'x-deny': '1' })).status).to.eq(403);
    expect(runs.get('list')).to.eq(1);
  });

  it('keeps principals apart unless the route shares its replies', async () => {
    expect((await get('/items/list', { 'x-user': 'bea' })).body).to.deep.eq({ run: 1 });
    expect((await get('/items/list', { 'x-user': 'cid' })).body).to.deep.eq({ run: 2 });
    expect((await get('/items/shared', { 'x-user': 'bea' })).body).to.deep.eq({ run: 1 });
    expect((await get('/items/shared', { 'x-user': 'cid' })).body).to.deep.eq({ run: 1 });
    expect((await get('/items/shared')).body).to.deep.eq({ run: 1 });
    expect((await get('/items/shared', { 'x-region': 'eu' })).body).to.deep.eq({ run: 2 });
  });

  it('puts the query, Accept, the data transformer, the language and the tenant into the key', async () => {
    const as = { 'x-user': 'dee' };
    await get('/items/list', as);
    await get('/items/list?page=2', as);
    await get('/items/list', { ...as, accept: 'application/json, text/plain' });
    await get('/items/list', { ...as, 'x-lang': 'pl' });
    await get('/items/list', { ...as, 'x-tenant': 'acme' });
    // 'pure' is http's built-in transformer: the header picks how the body is shaped
    await get('/items/list', { ...as, 'x-data-transform': 'pure' });
    expect(runs.get('list')).to.eq(6);

    await get('/items/list', { ...as, 'x-lang': 'pl' });
    await get('/items/list', { ...as, 'x-tenant': 'acme' });
    await get('/items/list', { ...as, 'x-data-transform': 'pure' });
    expect(runs.get('list')).to.eq(6);
  });

  it('stores only a plain 200 JSON reply: no other status, no cookie, no no-store, no error reply', async () => {
    for (const path of ['accepted', 'cookie', 'nostore', 'failing']) {
      await get(`/items/${path}`, { 'x-user': 'eve' });
      await get(`/items/${path}`, { 'x-user': 'eve' });
    }
    expect([runs.get('accepted'), runs.get('cookie'), runs.get('nostore'), runs.get('failing')]).to.deep.eq([2, 2, 2, 2]);
  });

  it('says once per route, without who asked, that a no-store reply is not stored', async () => {
    await get('/items/nostore', { 'x-user': 'eli' });
    await get('/items/nostore', { 'x-user': 'eli' });
    const said = cacheWarnings().filter((text) => text.includes('/items/nostore') && text.includes('no-store'));
    expect(said).to.have.length(1);
    expect(said[0]).to.not.contain('eli');
  });

  it('never stores a reply that is not JSON', async () => {
    // neither JSON nor HTML is acceptable, so http answers text/plain, which proceed() does not capture
    await get('/items/list', { 'x-user': 'ivy', accept: 'text/plain' });
    await get('/items/list', { 'x-user': 'ivy', accept: 'text/plain' });
    expect(runs.get('list')).to.eq(2);
  });

  it('does not share a reply CacheControl marked private, its answer to a request with Authorization', async () => {
    await get('/items/personal', { authorization: 'Bearer t' });
    await get('/items/personal', { authorization: 'Bearer t' });
    expect(runs.get('personal')).to.eq(2);
    await get('/items/personal');
    await get('/items/personal');
    expect(runs.get('personal')).to.eq(3);
  });

  it('runs a per-principal route uncached for a request without a principal, or with an unauthenticated one', async () => {
    await get('/items/list');
    await get('/items/list');
    expect(runs.get('list')).to.eq(2);
    await get('/items/list', { 'x-anonymous': '1' });
    await get('/items/list', { 'x-anonymous': '1' });
    expect(runs.get('list')).to.eq(4);
  });

  it('does not read the principal @spinajs/authn-http alone leaves: such a per-principal request runs uncached', async () => {
    await get('/items/list', { 'x-authn-only': 'ora' });
    await get('/items/list', { 'x-authn-only': 'ora' });
    expect(runs.get('list')).to.eq(2);
  });

  it('answers the request when a key part or the cache fails, and stores nothing then', async () => {
    for (const fail of ['key', 'scope']) {
      const as = { 'x-user': `pat-${fail}`, 'x-fail': fail };
      expect((await get('/items/list', as)).status).to.eq(200);
      expect((await get('/items/list', as)).status).to.eq(200);
    }
    expect(runs.get('list')).to.eq(4);
  });

  it('answers uncached, with one warning per request, when the store does not answer within cache.http.timeout', async function () {
    this.timeout(10000);
    expect((await get('/items/hung', { 'x-user': 'uma' })).body).to.deep.eq({ run: 1 });
    expect((await get('/items/hung', { 'x-user': 'uma' })).body).to.deep.eq({ run: 2 });
    expect(cacheWarnings().filter((text) => text.includes('/items/hung') && text.includes('lookup failed'))).to.have.length(2);
  });

  it('says at registration that the key cannot see what an action reads through @Req(), and still shares the route', async () => {
    expect(cacheWarnings().filter((text) => text.includes('GET /items/raw') && text.includes('takes the request or the response'))).to.have.length(1);
    await get('/items/raw', { 'x-user': 'vic' });
    expect((await get('/items/raw', { 'x-user': 'wes' })).body).to.deep.eq({ run: 1, method: 'GET' });
  });

  it('drops a stored reply when one of its tags is invalidated', async () => {
    await get('/items/list', { 'x-user': 'fay' });
    await cache('default', server.app!.container).invalidate(['any:item']);
    expect((await get('/items/list', { 'x-user': 'fay' })).body).to.deep.eq({ run: 2 });
  });

  it('answers HEAD from a stored GET reply, without a body', async () => {
    await get('/items/list', { 'x-user': 'gus' });
    const head = await send('HEAD', '/items/list', { 'x-user': 'gus' });
    expect([head.status, head.body, runs.get('list')]).to.deep.eq([200, null, 1]);
  });

  it('stores nothing for a HEAD request on a GET route: the method is not in the key', async () => {
    await send('HEAD', '/items/list', { 'x-user': 'hex' });
    await get('/items/list', { 'x-user': 'hex' });
    await get('/items/list', { 'x-user': 'hex' });
    expect(runs.get('list')).to.eq(2);
  });

  it('sends a stored value only when it is a reply it may send; any other is a miss', async () => {
    const replies = cache('default', server.app!.container);
    // the key the middleware computes for GET /items/list of this user; a wrong form fails the first expectation
    const plant = async (user: string, value: unknown): Promise<void> => {
      const route = { namespace: responseCacheNamespace('get', '/items/list'), scope: 'principal' as const, vary: [] };
      const key = responseCacheKey(route, { originalUrl: '/items/list', headers: { accept: 'application/json' } }, signedIn(user), [], []);
      if (key === undefined) throw new Error('no key for a signed-in user');
      await (await replies.lookup<unknown>(key, { ttl: '1m', layer: 'http' })).fill?.(value);
    };

    await plant('zoe', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"planted":1}' });
    expect((await get('/items/list', { 'x-user': 'zoe' })).body).to.deep.eq({ planted: 1 });

    await plant('zed', { status: 200, headers: { 'content-type': 'text/html' }, body: '<b>planted</b>' });
    const answer = await get('/items/list', { 'x-user': 'zed' });
    expect([answer.status, answer.body, runs.get('list')]).to.deep.eq([200, { run: 1 }, 1]);
    expect(String(answer.headers['content-type'])).to.match(/^application\/json/);
  });

  it("reads the CacheScope providers inside the request's store", async () => {
    await get('/items/list', { 'x-user': 'hal', 'x-no-cache': '1' });
    await get('/items/list', { 'x-user': 'hal', 'x-no-cache': '1' });
    expect(runs.get('list')).to.eq(2);
  });

  it('never answers from the store a route with an inner middleware mounted after @ResponseCache', async () => {
    await get('/items/stamped', { 'x-user': 'jay' });
    await get('/items/stamped', { 'x-user': 'jay' });
    expect([runs.get('stamped'), runs.get('stamp')]).to.deep.eq([2, 2]);
  });

  it('runs a request uncached whose x-data-transform shapes the reply per caller, on a shared and on a per-principal route', async () => {
    const as = (user: string) => ({ 'x-user': user, 'x-data-transform': 'per-caller' });
    expect((await get('/items/view', as('kim'))).body).to.deep.eq({ data: { run: 1 }, for: 'kim' });
    expect((await get('/items/view', as('lea'))).body).to.deep.eq({ data: { run: 2 }, for: 'lea' });
    await get('/items/view', { 'x-user': 'kim' });
    await get('/items/view', { 'x-user': 'lea' });
    expect(runs.get('view')).to.eq(3);
    // per principal too: a replay would keep the fields of kim's decision at store time
    await get('/items/list', as('kim'));
    await get('/items/list', as('kim'));
    expect(runs.get('list')).to.eq(2);
  });

  it('never answers from the store a shared route on which a global route middleware shapes the reply per caller', async () => {
    await get('/items/redacted', { 'x-user': 'kai' });
    await get('/items/redacted', { 'x-user': 'kai' });
    expect(runs.get('redacted')).to.eq(2);
  });
});
