import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import { TEST_TOKEN } from './common.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { Metrics } from './../src/index.js';

describe('GET /metrics', function () {
  this.timeout(15000);

  let app: TestApp;
  const req = () => app.request();

  // The token becomes service:telemetry, which the fragment's RBAC role grants telemetry:read.
  before(async () => {
    app = await startApp({ rbac: true });
  });

  after(async () => {
    await stopApp();
  });

  it('returns prometheus exposition text with the token', async () => {
    const metrics = DI.get(Metrics) ?? (await DI.resolve(Metrics));
    const map = metrics.defineMetrics('probe', [{ name: 'hits_total', help: 'probe hits', type: 'counter' }]);
    (map['hits_total'] as any).inc();

    const res = await req().get('/metrics').set('x-metrics-token', TEST_TOKEN);

    expect(res).to.have.status(200);
    expect(res.header['content-type']).to.contain('text/plain');
    expect(res.text).to.contain('probe_hits_total');
  });

  it('exposes the http request metrics recorded by the middleware', async () => {
    await req().get('/metrics').set('x-metrics-token', TEST_TOKEN);
    const res = await req().get('/metrics').set('x-metrics-token', TEST_TOKEN);

    expect(res.text).to.contain('http_requests_total');
    expect(res.text).to.contain('http_request_duration_ms');
  });
});
