import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type * as express from 'express';
import { DI } from '@spinajs/di';
import type { Request } from '@spinajs/http';

import { TEST_TOKEN } from './common.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { Metrics, TelemetryMiddleware, TelemetryStore } from './../src/index.js';

async function servedHealthCount(): Promise<number> {
  const text = await (await DI.resolve(Metrics)).render();
  return text
    .split('\n')
    .filter((l) => l.startsWith('http_requests_total{') && l.includes('health') && l.includes('status="200"'))
    .reduce((sum, l) => sum + Number(l.split(' ').pop()), 0);
}

describe('telemetry off switches', function () {
  this.timeout(15000);

  let app: TestApp;
  const get = (path: string) => app.request().get(path).set('Accept', 'application/json');
  const guarded = (path: string) => get(path).set('x-metrics-token', TEST_TOKEN);

  afterEach(async () => {
    await stopApp();
  });

  it('records no request metrics when telemetry.http.enabled is false', async () => {
    app = await startApp({ config: { 'telemetry.http.enabled': false } });
    const store = await DI.resolve(TelemetryStore);
    const seriesBefore = await servedHealthCount();
    const requestsBefore = store.RequestStats.requests;

    expect(await get('/telemetry/health')).to.have.status(200);
    expect(await get('/telemetry/health')).to.have.status(200);

    expect(await servedHealthCount(), 'no http_requests_total sample').to.eq(seriesBefore);
    expect(store.RequestStats.requests, 'nothing recorded into the JSON stats').to.eq(requestsBefore);
  });

  it('keeps super.before() callable when telemetry.http.enabled is false, so a wrapping subclass serves requests', async () => {
    app = await startApp({ config: { 'telemetry.http.enabled': false } });
    const store = await DI.resolve(TelemetryStore);
    const requestsBefore = store.RequestStats.requests;

    const timed = new TelemetryMiddleware().before();
    const res = { on: sinon.spy() } as unknown as express.Response;
    const next = sinon.spy();
    timed({ storage: {}, method: 'GET', path: '/x' } as unknown as Request, res, next);

    expect(next.calledOnce, 'the request goes on').to.eq(true);
    expect((res.on as sinon.SinonSpy).called, 'no finish listener, so nothing is recorded').to.eq(false);
    expect(store.RequestStats.requests).to.eq(requestsBefore);
  });

  it('answers 404 on each data route turned off, before any credential check', async () => {
    app = await startApp({
      rbac: true,
      config: {
        'telemetry.endpoints.stats.enabled': false,
        'telemetry.endpoints.timeline.enabled': false,
        'telemetry.endpoints.routes.enabled': false,
      },
    });

    for (const path of ['/telemetry/stats', '/telemetry/timeline', '/telemetry/routes']) {
      const withToken = await guarded(path);
      expect(withToken, `${path} with the token`).to.have.status(404);
      expect(withToken.body, 'the answer of a path no route matches').to.deep.include({ message: `Route not found: GET ${path}` });
      expect(await get(path), `${path} without credentials`).to.have.status(404);
    }

    expect(await guarded('/telemetry/perf'), 'a route left on still answers').to.have.status(200);
    expect(await get('/telemetry/perf'), 'a route left on still checks credentials').to.have.status(401);
  });
});
