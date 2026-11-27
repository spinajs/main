import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { request } from 'node:http';
import { CacheScope, cache } from '@spinajs/cache';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Controllers, Get, HTTP_STATUS_CODE, HttpServer, Ok } from '@spinajs/http';
import { ResponseCache, ResponseCacheMiddleware } from '../src/index.js';
import { cacheWarnings, run, runs, useServer } from './support/server.js';

const PUBLIC = 'the test reply is the same for every caller';

/** cache.http.waitTimeout of this file: long enough for a test step, short enough to wait for once. */
const WAIT_MS = 1500;

/** How often plan A read the scope since the test started: once per lookup, never for a fill. */
let scopeReads = 0;

/** The tenant as only a CacheScope sees it (CA5 without tenancy-http): a store segment, not a part of this package's key. */
class TenantScope extends CacheScope {
  public segments(): readonly string[] {
    scopeReads += 1;
    const store: unknown = DI.resolve(AsyncLocalStorage).getStore();
    const tenant: unknown = typeof store === 'object' && store !== null ? Reflect.get(store, 'TestTenant') : undefined;
    return typeof tenant === 'string' ? [`tenant:${tenant}`] : [];
  }
}

/** Holds an action until the test lets it go. */
class Gate {
  public readonly wait: Promise<void>;
  private open!: () => void;

  constructor() {
    this.wait = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  public release(): void {
    this.open();
  }
}

let gate = new Gate();

/** How the first run of /slow/flaky ends; every later run answers a plain reply. */
type Failure = 'throw' | 'status' | 'no-store' | 'cookie' | 'gone';
let leaderFails: Failure = 'throw';

/** The run of /slow/stale that throws; 0 for none. */
let failingRun = 0;

const byRun = (answer: { body: unknown }): string => JSON.stringify(answer.body);

const shared = (more: { ttl: string; swr?: string; tags?: string[] }) => ({ ...more, scope: 'shared' as const, sharedBecause: PUBLIC });

@BasePath('slow')
class Slow extends BaseController {
  @Get('fresh')
  @ResponseCache(shared({ ttl: '1m' }))
  public async fresh() {
    const n = run('fresh');
    await gate.wait;
    return new Ok({ run: n }, { Headers: [{ Name: 'X-Run', Value: String(n) }] });
  }

  @Get('stale')
  @ResponseCache(shared({ ttl: '300ms', swr: '1m', tags: ['any:price'] }))
  public async stale() {
    const n = run('stale');
    await gate.wait;
    if (n === failingRun) throw new Error('the refresh failed');
    return new Ok({ run: n }, { Headers: [{ Name: 'X-Run', Value: String(n) }] });
  }

  @Get('brief')
  @ResponseCache(shared({ ttl: '300ms', swr: '300ms' }))
  public async brief() {
    const n = run('brief');
    await gate.wait;
    return new Ok({ run: n });
  }

  @Get('own')
  @ResponseCache({ ttl: '300ms', swr: '1m' })
  public async own() {
    const n = run('own');
    await gate.wait;
    return new Ok({ run: n });
  }

  @Get('keyed')
  @ResponseCache({ ttl: '1m', vary: ['x-region'] })
  public async keyed() {
    const n = run('keyed');
    await gate.wait;
    return new Ok({ run: n });
  }

  @Get('flaky')
  @ResponseCache(shared({ ttl: '1m' }))
  public async flaky() {
    const n = run('flaky');
    await gate.wait;
    if (n > 1) return new Ok({ run: n });
    if (leaderFails === 'throw') throw new Error('the first run failed');
    if (leaderFails === 'status') return new Ok({ run: n }, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
    if (leaderFails === 'cookie') return new Ok({ run: n }, { Headers: [{ Name: 'Set-Cookie', Value: 'seen=1' }] });
    return new Ok({ run: n }, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  @Get('hang')
  @ResponseCache(shared({ ttl: '1m' }))
  public async hang() {
    const n = run('hang');
    if (n === 1) await gate.wait;
    return new Ok({ run: n });
  }

  @Get('report')
  @ResponseCache(shared({ ttl: '1m' }))
  public async report() {
    const n = run('report');
    await settle(600);
    return new Ok({ run: n });
  }

  @Get('tagged')
  @ResponseCache(shared({ ttl: '1m', tags: ['any:flight'] }))
  public async tagged() {
    const n = run('tagged');
    await gate.wait;
    return new Ok({ run: n });
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).to.eq(true);
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sizeOf = (owner: unknown, field: string): number => {
  const value: unknown = typeof owner === 'object' && owner !== null ? Reflect.get(owner, field) : undefined;
  return value instanceof Map || value instanceof Set ? value.size : NaN;
};

/** The warnings of a route whose request stopped waiting for another request's run of its key. */
const waitsGivenUp = (route: string): number => cacheWarnings().filter((text) => text.includes(route) && text.includes('cache.http.waitTimeout')).length;

describe('@ResponseCache with concurrent and stale requests', function () {
  this.timeout(60000);

  const { server, get } = useServer(
    [Slow],
    (c: IContainer) => {
      c.register(TenantScope).as(CacheScope);
    },
    [],
    { waitTimeout: WAIT_MS },
  );

  /** The response cache of every route of Slow, kept to be read after the server is disposed. */
  let middlewares: ResponseCacheMiddleware[] = [];

  /** Keys of in-flight runs and refreshes the response caches of Slow hold. */
  const inTheAir = (): number => middlewares.reduce((sum, m) => sum + sizeOf(m, 'inFlight') + sizeOf(m, 'refreshing'), 0);

  before(async () => {
    const listed = await (await server.app!.resolve(Controllers)).Controllers;
    const slow = listed.map((c) => c.instance).find((c) => c instanceof Slow);
    if (slow === undefined) throw new Error('Slow is not mounted');
    middlewares = [...slow.Routes.keys()].flatMap((method) => slow.MountedMiddlewares(method)).filter((m) => m instanceof ResponseCacheMiddleware);
  });

  after(() => {
    // runs after useServer's after: the server is stopped and the application disposed
    expect([middlewares.length, inTheAir()]).to.deep.eq([9, 0]);
  });

  beforeEach(() => {
    gate = new Gate();
    scopeReads = 0;
    failingRun = 0;
  });

  /** Stores run 1 of /slow/stale for the tenant, lets it go stale, and closes the gate again. */
  async function staleEntry(tenant: string): Promise<Record<string, string>> {
    const as = { 'x-tenant': tenant };
    gate.release();
    expect((await get('/slow/stale', as)).body).to.deep.eq({ run: 1 });
    await settle(400);
    gate = new Gate();
    return as;
  }

  /** A GET whose client goes away once `left` holds. */
  function abandoned(path: string, left: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: server.port, path, headers: { accept: 'application/json' } });
      req.on('error', () => resolve());
      req.end();
      void until(left).then(() => req.destroy());
    });
  }

  it('runs the route once for concurrent misses of one key; the others get its reply', async () => {
    const first = get('/slow/fresh');
    await until(() => runs.get('fresh') === 1);
    const looked = scopeReads;
    const second = get('/slow/fresh');
    // once the second request has looked the key up it has missed (the gate keeps the first from storing), so from
    // here on only single flight keeps it from running the route
    await until(() => scopeReads > looked);
    expect(runs.get('fresh')).to.eq(1);
    gate.release();
    expect([(await first).body, (await second).body, runs.get('fresh')]).to.deep.eq([{ run: 1 }, { run: 1 }, 1]);
  });

  it('gives a waiter the stored reply through its own lookup, without the headers of the run it waited for', async () => {
    const first = get('/slow/fresh?for=headers');
    await until(() => runs.get('fresh') === 1);
    const looked = scopeReads;
    const second = get('/slow/fresh?for=headers');
    await until(() => scopeReads > looked);
    gate.release();
    const [leader, waiter] = await Promise.all([first, second]);
    expect([leader.headers['x-run'], waiter.body, waiter.headers['x-run'], runs.get('fresh')]).to.deep.eq(['1', { run: 1 }, undefined, 1]);
  });

  it('runs its own route for a concurrent miss of another principal, language or vary value, without waiting', async () => {
    const callers: Record<string, string>[] = [{ 'x-user': 'ann' }, { 'x-user': 'bob' }, { 'x-user': 'ann', 'x-lang': 'pl' }, { 'x-user': 'ann', 'x-region': 'eu' }];
    const sent = callers.map((as) => get('/slow/keyed', as));
    await until(() => runs.get('keyed') === 4);
    gate.release();
    const answers = await Promise.all(sent);
    expect(new Set(answers.map(byRun)).size).to.eq(4);
    expect(waitsGivenUp('/slow/keyed')).to.eq(0);
  });

  it('runs a waiting request of another cache scope after the run it waited for, from its own lookup', async () => {
    const first = get('/slow/fresh?for=scope', { 'x-tenant': 'acme' });
    await until(() => runs.get('fresh') === 1);
    const looked = scopeReads;
    const other = get('/slow/fresh?for=scope', { 'x-tenant': 'globex' });
    await until(() => scopeReads > looked);
    gate.release();
    expect([(await first).body, (await other).body]).to.deep.eq([{ run: 1 }, { run: 2 }]);
  });

  for (const failure of ['throw', 'status', 'no-store', 'cookie', 'gone'] as const) {
    it(`lets each waiter run its own route when the run it waited for fails (${failure}), and stores nothing of that run`, async () => {
      leaderFails = failure;
      const path = `/slow/flaky?case=${failure}`;
      const first = failure === 'gone' ? abandoned(path, () => scopeReads >= 3) : get(path);
      await until(() => runs.get('flaky') === 1);
      const waiters = [get(path), get(path)];
      await until(() => scopeReads >= 3);
      if (failure === 'gone') await settle(100);
      gate.release();
      await first;
      const answers = await Promise.all(waiters);
      expect(answers.map((a) => [a.status, a.headers['set-cookie']])).to.deep.eq([
        [200, undefined],
        [200, undefined],
      ]);
      expect(answers.map(byRun).sort()).to.deep.eq(['{"run":2}', '{"run":3}']);
      expect((await get(path)).body).to.not.deep.eq({ run: 1 });
      expect(runs.get('flaky')).to.eq(3);
    });
  }

  it('stops waiting at cache.http.waitTimeout for a run that does not end, and runs its own route', async () => {
    const first = get('/slow/hang');
    await until(() => runs.get('hang') === 1);
    const answers = await Promise.all([get('/slow/hang'), get('/slow/hang')]);
    // each ran its own route, or found the one the other stored: never the held first run
    expect(answers.map((a) => [a.status, byRun(a) === '{"run":1}'])).to.deep.eq([
      [200, false],
      [200, false],
    ]);
    expect([waitsGivenUp('/slow/hang'), inTheAir()]).to.deep.eq([1, 0]);
    expect((await get('/slow/hang')).body).to.not.deep.eq({ run: 1 });
    gate.release();
    expect((await first).body).to.deep.eq({ run: 1 });
  });

  it('runs a route slower than cache.http.timeout once for 20 concurrent misses of its key', async () => {
    const answers = await Promise.all(Array.from({ length: 20 }, () => get('/slow/report')));
    expect([runs.get('report'), new Set(answers.map(byRun)).size]).to.deep.eq([1, 1]);
  });

  it('refuses a cache.http.waitTimeout that is not a whole number of milliseconds above 0, as it refuses such a timeout', async () => {
    const config = await server.app!.resolve(Configuration);
    for (const value of [0, -5, 1.5, Infinity]) expect(() => config.set('cache.http.waitTimeout', value), String(value)).to.throw(InvalidConfiguration);
    expect(() => config.set('cache.http.timeout', 0)).to.throw(InvalidConfiguration);
    config.set('cache.http.waitTimeout', WAIT_MS);
  });

  it('leaves no flight behind a failed run that no other request of the key follows', async () => {
    leaderFails = 'throw';
    gate.release();
    expect((await get('/slow/flaky?case=lone')).status).to.eq(500);
    expect(inTheAir()).to.eq(0);
  });

  it('hands no request the reply of a run an invalidation reached while it ran', async () => {
    const first = get('/slow/tagged');
    await until(() => runs.get('tagged') === 1);
    let looked = scopeReads;
    const early = get('/slow/tagged');
    await until(() => scopeReads > looked);
    await cache('default', server.app!.container).invalidate(['any:flight']);
    looked = scopeReads;
    const late = get('/slow/tagged');
    await until(() => scopeReads > looked);
    gate.release();
    const answers = await Promise.all([first, early, late]);
    expect(answers.map(byRun).sort()).to.deep.eq(['{"run":1}', '{"run":2}', '{"run":3}']);
    expect(answers[0].body).to.deep.eq({ run: 1 });
    expect((await get('/slow/tagged')).body).to.not.deep.eq({ run: 1 });
    expect(runs.get('tagged')).to.eq(3);
  });

  it('serves the stale reply from the store while one request runs the route again', async () => {
    const as = await staleEntry('one');
    const refreshing = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    expect((await get('/slow/stale', as)).body).to.deep.eq({ run: 1 });

    gate.release();
    expect((await refreshing).body).to.deep.eq({ run: 2 });
    expect((await get('/slow/stale', as)).body).to.deep.eq({ run: 2 });
    expect(runs.get('stale')).to.eq(2);
  });

  it('stores of a refresh only what a miss stores: not the headers of the request that refreshed', async () => {
    const as = await staleEntry('eight');
    const refreshing = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    const during = await get('/slow/stale', as);
    gate.release();
    const refreshed = await refreshing;
    const after = await get('/slow/stale', as);
    expect([refreshed.headers['x-run'], during.headers['x-run'], after.body, after.headers['x-run']]).to.deep.eq(['2', undefined, { run: 2 }, undefined]);
  });

  it('never serves a stale reply that an invalidation reached during the refresh', async () => {
    const as = await staleEntry('two');
    const refreshing = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    await cache('default', server.app!.container).invalidate(['any:price']);
    const after = get('/slow/stale', as);
    // a miss: it runs the route itself instead of getting the invalidated reply
    await until(() => runs.get('stale') === 3);
    gate.release();
    expect([(await refreshing).body, (await after).body]).to.deep.eq([{ run: 2 }, { run: 3 }]);
  });

  it('never stores the reply of a refresh that an invalidation reached while it ran', async () => {
    const as = await staleEntry('six');
    const refreshing = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    await cache('default', server.app!.container).invalidate(['any:price']);
    gate.release();
    expect((await refreshing).body).to.deep.eq({ run: 2 });
    expect((await get('/slow/stale', as)).body).to.deep.eq({ run: 3 });
  });

  it('keeps the stale entry when the refresh fails, and the next request refreshes it again', async () => {
    const as = await staleEntry('seven');
    failingRun = 2;
    const failed = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    gate.release();
    expect((await failed).status).to.eq(500);
    gate = new Gate();
    const again = get('/slow/stale', as);
    await until(() => runs.get('stale') === 3);
    expect((await get('/slow/stale', as)).body).to.deep.eq({ run: 1 });
    gate.release();
    expect((await again).body).to.deep.eq({ run: 3 });
  });

  it('gives a request of another cache scope only what its own scope stored', async () => {
    const as = await staleEntry('three');
    const refreshing = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    const other = get('/slow/stale', { 'x-tenant': 'four' });
    await until(() => runs.get('stale') === 3);
    gate.release();
    expect([(await refreshing).body, (await other).body]).to.deep.eq([{ run: 2 }, { run: 3 }]);
  });

  it("serves a principal's stale reply to that principal only", async () => {
    gate.release();
    await get('/slow/own', { 'x-user': 'ann' });
    gate = new Gate();
    await settle(400);
    const refreshing = get('/slow/own', { 'x-user': 'ann' });
    await until(() => runs.get('own') === 2);
    expect((await get('/slow/own', { 'x-user': 'ann' })).body).to.deep.eq({ run: 1 });
    const bob = get('/slow/own', { 'x-user': 'bob' });
    await until(() => runs.get('own') === 3);
    gate.release();
    expect([(await refreshing).body, (await bob).body]).to.deep.eq([{ run: 2 }, { run: 3 }]);
  });

  it('serves no stale reply past ttl and swr: a request then waits for the run of the key', async () => {
    gate.release();
    expect((await get('/slow/brief')).body).to.deep.eq({ run: 1 });
    gate = new Gate();
    await settle(800);
    const first = get('/slow/brief');
    await until(() => runs.get('brief') === 2);
    const looked = scopeReads;
    const second = get('/slow/brief');
    await until(() => scopeReads > looked);
    gate.release();
    expect([(await first).body, (await second).body]).to.deep.eq([{ run: 2 }, { run: 2 }]);
  });

  it('leaves no flight and no refresh behind when the server stops while they run', async () => {
    const as = await staleEntry('nine');
    const refreshing = get('/slow/stale', as);
    await until(() => runs.get('stale') === 2);
    const first = get('/slow/fresh?for=stop');
    await until(() => runs.get('fresh') === 1);
    const looked = scopeReads;
    const waiter = get('/slow/fresh?for=stop');
    await until(() => scopeReads > looked);
    const stopped = DI.get(HttpServer)?.stop();
    gate.release();
    expect([(await refreshing).body, (await first).body, (await waiter).body]).to.deep.eq([{ run: 2 }, { run: 1 }, { run: 1 }]);
    await stopped;
    expect(inTheAir()).to.eq(0);
  });
});

@BasePath('stuck')
class Stuck extends BaseController {
  @Get('forever')
  @ResponseCache(shared({ ttl: '1m' }))
  public async forever() {
    run('stuck');
    await new Promise<void>(() => undefined);
    return new Ok({});
  }
}

describe('@ResponseCache waits when the application is disposed', function () {
  this.timeout(180000);

  // a wait far longer than the test server's shutdown (http.shutdownTimeout 1000)
  const { server, get } = useServer([Stuck], () => undefined, [], { waitTimeout: 60000 });

  it('ends all 500 waits on a run that never finishes: no timer, no flight and no dispose listener left behind', async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => void warnings.push(warning.message);
    process.on('warning', onWarning);
    const listed = await (await server.app!.resolve(Controllers)).Controllers;
    const stuck = listed.map((c) => c.instance).find((c) => c instanceof Stuck);
    const middleware = stuck?.MountedMiddlewares('forever').find((m) => m instanceof ResponseCacheMiddleware);
    const waiting = (): number => sizeOf(Reflect.get(middleware ?? {}, 'Waits'), 'pending');
    const timers = (): number => process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
    const listeners = (): number => server.app!.container.listenerCount('di.dispose');
    const before = { timers: timers(), listeners: listeners() };

    const sent = [get('/stuck/forever').catch(() => undefined)];
    await until(() => runs.get('stuck') === 1);
    for (let batch = 1; batch <= 5; batch++) {
      for (let i = 0; i < 100; i++) sent.push(get('/stuck/forever').catch(() => undefined));
      await until(() => waiting() === batch * 100, 30000);
    }
    expect([timers() >= before.timers + 500, listeners()]).to.deep.eq([true, before.listeners]);

    await server.app!.dispose();
    expect(waiting()).to.eq(0);
    await Promise.all(sent);
    await until(() => sizeOf(middleware, 'inFlight') === 0, 15000);
    process.off('warning', onWarning);
    expect([timers() <= before.timers, listeners(), warnings]).to.deep.eq([true, before.listeners, []]);
  });
});
