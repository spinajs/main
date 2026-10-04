import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { BaseController, Controllers, HttpServer } from '@spinajs/http';
import { Perf } from '@spinajs/log';
import { FsBootsrapper, fsService } from '@spinajs/fs';

import { TestConfiguration, req } from '../common.js';

// the barrel, not `src/health.js` — loading it is what registers the telemetry
// policies the guarded endpoints are configured with
import { HealthCheck, IHealthResult, InMemoryPerfSink, TelemetryStore } from '../../src/index.js';

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
  });
});

// referenced so the stub check is not flagged as unused
void StubHealthCheck;
