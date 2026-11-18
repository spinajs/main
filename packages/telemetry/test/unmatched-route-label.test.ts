import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { Metrics, TelemetryStore } from './../src/index.js';

async function requestSeries(): Promise<string[]> {
  const text = await (await DI.resolve(Metrics)).render();
  return text.split('\n').filter((l) => l.startsWith('http_requests_total{'));
}

function count(lines: string[], route: string, status: string): number {
  const line = lines.find((l) => l.includes(`route="${route}"`) && l.includes(`status="${status}"`) && l.includes('method="GET"'));
  return line ? Number(line.split(' ').pop()) : 0;
}

describe('unmatched requests share one route label', function () {
  this.timeout(15000);

  let app: TestApp;
  const get = (path: string) => app.request().get(path).set('Accept', 'application/json');

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp();
  });

  it('labels requests no route matched with one fixed route, not their path', async () => {
    const before = count(await requestSeries(), '<unmatched>', '404');

    expect(await get('/random-1')).to.have.status(404);
    expect(await get('/random-2')).to.have.status(404);

    const series = await requestSeries();
    expect(series.filter((l) => l.includes('random-')), 'a raw path must never become a route label').to.deep.eq([]);
    expect(count(series, '<unmatched>', '404')).to.eq(before + 2);

    const routes = (await DI.resolve(TelemetryStore)).RouteStats.toJSON().routes.map((r) => r.route);
    expect(routes.filter((r) => r.includes('random-'))).to.deep.eq([]);
    expect(routes).to.include('<unmatched>');
  });

  it('keeps the matched route pattern for a served route', async () => {
    expect(await get('/telemetry/health')).to.have.status(200);

    const series = await requestSeries();
    const health = series.filter((l) => l.includes('health') && l.includes('status="200"'));
    expect(health, 'the served route keeps its own series').to.have.length(1);
    expect(health[0]).to.not.include('<unmatched>');
  });
});
