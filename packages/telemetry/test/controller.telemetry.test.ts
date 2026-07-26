import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { Perf } from '@spinajs/log';
import { FsBootsrapper, fsService } from '@spinajs/fs';

import { TestConfiguration, req, TEST_TOKEN } from './common.js';

// the barrel, not `src/health.js` — loading it is what registers the telemetry
// policies the guarded endpoints are configured with
import { HealthCheck, IHealthResult, InMemoryPerfSink, Metrics, TelemetryStore } from './../src/index.js';

let failCheck = false;

@Injectable(HealthCheck)
class StubHealthCheck extends HealthCheck {
  public Name = 'stub';

  public check(): Promise<IHealthResult> {
    return Promise.resolve(failCheck ? { status: 'down', message: 'stub is down' } : { status: 'up' });
  }
}

/**
 * Every assertion below inspects a JSON body, so `Accept: application/json` is
 * mandatory: with no Accept header express reports `accepts( 'html' )` and the
 * framework renders the pug representation of the response instead — that is
 * true of a plain `Ok` too, not only of error responses.
 */
function json(path: string) {
  return req().get(path).set('Accept', 'application/json');
}

function guarded(path: string) {
  return json(path).set('x-metrics-token', TEST_TOKEN);
}

/**
 * Current value of a label-less gauge in the private prom registry.
 */
async function gauge(name: string): Promise<number> {
  const text = await (await DI.resolve(Metrics)).render();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));

  expect(line, `${name} must be present in the registry`).to.not.be.undefined;
  return Number(line!.split(' ')[1]);
}

const BUCKET_MS = 60_000;

describe('telemetry json api', function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    DI.setESMModuleSupport();

    // The fs providers must exist before Controllers resolves — the controller
    // cache and the response templates both read through them.
    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    const controllers = await DI.resolve<Controllers>(Controllers);
    const server = await DI.resolve(HttpServer);
    server.start();

    // PRE-EXISTING harness quirk, unrelated to what this file tests: reflection's
    // `@ListFromFiles` memoizes the file-scanned controller INSTANCES on the
    // decorated prototype for the life of the PROCESS, and `DI.clearCache()`
    // cannot reach that memo ( the property is non-configurable and the memo is
    // a closure ). So in a whole-suite run — where another file booted a server
    // first — the instance express mounts here was built during THAT boot and
    // still holds that container's store and perf sink, while the middleware and
    // the Perf facade resolved for THIS boot write into this container's. Point
    // the mounted controller back at the current ones, or the file would read a
    // different half of the pipeline than the one being written to. Run alone,
    // these two assignments are no-ops — the instances are already the same.
    const loaded = (await (controllers as any).Controllers) as Array<{ name: string; instance: BaseController }>;
    const controller = loaded.find((c) => c.name === 'TelemetryController')?.instance as any;

    expect(controller, 'TelemetryController must be registered').to.not.be.undefined;

    const store = await DI.resolve(TelemetryStore);
    controller.Store = store;
    controller.PerfSink = await DI.resolve(InMemoryPerfSink);

    // The endpoints read that shared `TelemetryStore` singleton, which is also
    // what the mounted middleware writes to — so almost everything asserted in
    // this file is produced by REAL traffic through the server, not seeded.
    //
    // The one exception is a timeline bucket in the PAST: nothing real can
    // create one, and the timeline assertions need more than a single bucket
    // before ordering and limiting are observable at all.
    store.Timeline.record(200, 5, Date.now() - BUCKET_MS);

    // Prime the lifetime counters with real traffic — one served request and one
    // denied one — so the stats assertions do not depend on which describe block
    // mocha happens to run first.
    await json('telemetry/health');
    await json('telemetry/stats');

    // Real measurements through the Perf facade. These reach InMemoryPerfSink
    // only if the facade actually discovered that sink, which is the point.
    Perf.start('test.span').end();
    Perf.count('test.counter', 3);
  });

  beforeEach(() => {
    failCheck = false;
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  describe('auth', () => {
    it('rejects the guarded endpoints without a token', async () => {
      // The token policy throws Forbidden. In a fully-configured app that renders
      // as 403; this minimal harness trips a PRE-EXISTING quirk — `DI.clearCache()`
      // in `before()` wipes the `__http_error_map__` the response classes registered
      // at import time, so every mapped exception falls back to ServerError ( 500 ).
      // Assert the contract that actually matters: the request is denied and the
      // denial comes from THIS policy.
      for (const path of ['telemetry/stats', 'telemetry/timeline', 'telemetry/routes', 'telemetry/perf']) {
        const res = await json(path);

        expect(res.status, `${path} must be denied`).to.be.at.least(400);
        expect(JSON.stringify(res.body), path).to.contain('access token');
      }
    });

    it('rejects the guarded endpoints with a wrong token', async () => {
      const res = await json('telemetry/stats').set('x-metrics-token', 'nope');

      expect(res.status).to.be.at.least(400);
      expect(JSON.stringify(res.body)).to.contain('invalid access token');
    });

    it('leaves the probe endpoints open', async () => {
      expect(await json('telemetry/health')).to.have.status(200);
      expect(await json('telemetry/ready')).to.have.status(200);
    });
  });

  describe('GET /telemetry/stats', () => {
    it('returns lifetime stats and the timeline', async () => {
      const res = await guarded('telemetry/stats');

      expect(res).to.have.status(200);
      expect(res.body.all.requests).to.be.greaterThan(0);
      expect(res.body.all.errors).to.be.at.least(1);
      expect(Object.keys(res.body.timeline)).to.not.have.length(0);
    });

    it('computes the rates over the collection window', async () => {
      // updateRates() is the controller's job — the counters alone never carry a rate
      const res = await guarded('telemetry/stats');

      expect(res.body.all.req_rate).to.be.greaterThan(0);
      expect(res.body.all.err_rate).to.be.greaterThan(0);
    });
  });

  describe('GET /telemetry/timeline', () => {
    it('returns annotated buckets, not the raw snapshot map', async () => {
      const res = await guarded('telemetry/timeline');

      expect(res).to.have.status(200);
      expect(res.body.bucketMs).to.eq(BUCKET_MS);
      expect(res.body.length).to.eq(60);
      expect(res.body.buckets).to.be.an('array');
      expect(res.body.buckets.length).to.be.at.least(2);

      for (const bucket of res.body.buckets) {
        expect(bucket.key).to.be.a('number');
        expect(bucket.from).to.eq(bucket.key * BUCKET_MS);
        expect(bucket.to).to.eq((bucket.key + 1) * BUCKET_MS);
        expect(bucket.to - bucket.from).to.eq(BUCKET_MS);
        expect(bucket.stats.requests).to.be.greaterThan(0);
      }
    });

    it('returns the buckets in ascending key order', async () => {
      const res = await guarded('telemetry/timeline');
      const keys = res.body.buckets.map((b: any) => b.key);

      expect(keys).to.deep.eq([...keys].sort((a: number, b: number) => a - b));
    });

    it('limits to the LAST n buckets when asked', async () => {
      const newest = (body: any) => body.buckets[body.buckets.length - 1].key;

      const before = await guarded('telemetry/timeline');
      const res = await guarded('telemetry/timeline?buckets=1');
      const after = await guarded('telemetry/timeline');

      expect(res).to.have.status(200);
      expect(res.body.buckets).to.have.length(1);

      // there must be something to limit, or "the last one" proves nothing
      expect(before.body.buckets.length, 'more than one bucket must exist').to.be.at.least(2);

      // Wall clock can cross a minute boundary between the calls, which opens a
      // NEW newest bucket. So the limited response has to match the newest bucket
      // as seen on either side of it — but never an older one, which is exactly
      // what taking the tail rather than the head has to prove.
      expect([newest(before.body), newest(after.body)]).to.include(res.body.buckets[0].key);
    });

    it('rejects a bucket count that is not a positive integer', async () => {
      // The mapped 400 degrades to 500 in this harness ( see the auth note above ),
      // so assert the rejection plus the reason this endpoint itself produced.
      //
      // '' covers `?buckets=` — a value that WAS supplied and is not a positive
      // integer, so it is rejected like the rest instead of silently meaning
      // "all buckets". Omitting the parameter entirely still means "all".
      for (const value of ['abc', '0', '-1', '1.5', '']) {
        const res = await guarded(`telemetry/timeline?buckets=${value}`);

        expect(res.status, `buckets='${value}' must be rejected`).to.be.at.least(400);
        expect(JSON.stringify(res.body), `buckets='${value}'`).to.contain('buckets must be a positive integer');
      }
    });
  });

  describe('GET /telemetry/routes', () => {
    it('returns a per-route breakdown', async () => {
      const res = await guarded('telemetry/routes');

      expect(res).to.have.status(200);
      expect(res.body.truncated).to.eq(false);
      expect(res.body.routes).to.not.have.length(0);

      const health = res.body.routes.find((r: any) => r.route.includes('health'));
      expect(health, 'the served health route must be listed').to.not.be.undefined;
      expect(health.method).to.eq('GET');
      expect(health.stats.requests).to.be.greaterThan(0);
    });
  });

  describe('GET /telemetry/perf', () => {
    it('returns aggregated spans and events', async () => {
      const res = await guarded('telemetry/perf');

      expect(res).to.have.status(200);
      expect(res.body.truncated).to.eq(false);

      const span = res.body.spans.find((s: any) => s.name === 'test.span');
      expect(span, 'a span measured through the Perf facade must be listed').to.not.be.undefined;
      expect(span.count).to.eq(1);

      const counter = res.body.events.find((e: any) => e.name === 'test.counter');
      expect(counter, 'a counter measured through the Perf facade must be listed').to.not.be.undefined;
      expect(counter.total).to.eq(3);
    });
  });

  describe('GET /telemetry/health', () => {
    it('returns liveness info', async () => {
      const res = await json('telemetry/health');

      expect(res).to.have.status(200);
      expect(res.body.status).to.eq('up');
      expect(res.body.uptimeMs).to.be.a('number');
      expect(res.body.startedAt).to.be.a('number');
      expect(res.body.node).to.eq(process.version);
      expect(res.body.pid).to.eq(process.pid);
      expect(res.body.version).to.eq('9.9.9');
    });

    it('runs no health checks', async () => {
      // liveness must never be made slow or flaky by a dependency
      failCheck = true;

      const res = await json('telemetry/health');

      expect(res).to.have.status(200);
      expect(res.body.status).to.eq('up');
      expect(res.body.checks).to.be.undefined;
    });
  });

  describe('GET /telemetry/ready', () => {
    it('returns 200 and the check list when everything is up', async () => {
      const res = await json('telemetry/ready');

      expect(res).to.have.status(200);
      expect(res.body.status).to.eq('up');
      expect(res.body.checks.find((c: any) => c.name === 'stub').status).to.eq('up');
    });

    it('returns 503 when a check is down', async () => {
      failCheck = true;

      const res = await json('telemetry/ready');

      expect(res).to.have.status(503);
      expect(res.body.status).to.eq('down');
      expect(res.body.checks.find((c: any) => c.name === 'stub').message).to.eq('stub is down');
    });
  });

  /**
   * The end-to-end proof that the collection pipeline is actually wired up: the
   * middleware express mounted, the shared store and the controller are one
   * pipeline, so a request served by this very server shows up in the endpoints.
   */
  describe('live traffic', () => {
    /**
     * The hand-assignment in `before()` works around the reflection memo, but it
     * would also mask the very defect this store exists to fix: with the
     * controller pointed at the shared store by hand, every other assertion here
     * still passes even if `TelemetryStore` were not a `@Singleton()` at all.
     *
     * The mounted MIDDLEWARE is not re-pointed — it is freshly resolved on every
     * boot — so asserting that ITS store is the container's singleton pins the
     * sharing by construction, in a way no hand-assignment can fake.
     */
    it('the mounted middleware and the DI container share one TelemetryStore', async () => {
      const mws = (await DI.resolve(Array.ofType(ServerMiddleware))) as any[];
      const mounted = mws.find((m) => m.constructor.name === 'TelemetryMiddleware');

      expect(mounted, 'TelemetryMiddleware should be mounted').to.not.be.undefined;
      expect((mounted as any).Store).to.eq(await DI.resolve(TelemetryStore));
    });

    it('counts requests served by the server itself', async () => {
      const before = await guarded('telemetry/stats');
      await json('telemetry/health');
      const after = await guarded('telemetry/stats');

      expect(after.body.all.requests).to.be.greaterThan(before.body.all.requests);
    });

    it('lists the route it just served, with that route own counter advanced', async () => {
      const served = (body: any) => body.routes.find((r: any) => r.method === 'GET' && r.route.includes('ready'));

      const before = await guarded('telemetry/routes');
      await json('telemetry/ready');
      const after = await guarded('telemetry/routes');

      const entry = served(after.body);
      expect(entry, 'the served route must appear in the breakdown').to.not.be.undefined;
      expect(entry.stats.requests).to.be.greaterThan(served(before.body)?.stats.requests ?? 0);
    });

    it('returns the in-flight gauge to 0 once the response is done', async () => {
      await json('telemetry/health');

      // an inc() in before() with no matching dec() makes this climb forever
      expect(await gauge('http_requests_in_flight')).to.eq(0);
    });

    it('advances the prometheus request counter for the route it served', async () => {
      await json('telemetry/health');

      const text = await (await DI.resolve(Metrics)).render();
      const line = text.split('\n').find((l) => l.startsWith('http_requests_total{') && l.includes('health'));

      expect(line, 'http_requests_total must carry the served route').to.not.be.undefined;
      expect(Number(line!.split(' ').pop())).to.be.greaterThan(0);
    });
  });
});

// referenced so the stub check is not flagged as unused
void StubHealthCheck;
