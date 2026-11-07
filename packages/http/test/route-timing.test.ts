import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import type * as express from 'express';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Middleware, Ok, RouteTiming } from '../src/index.js';
import type { Request as sRequest, IServerTimingEntry } from '../src/index.js';

class RouteTimingFailure extends Error {}

@BasePath('route-timing')
class RouteTimingController extends BaseController {
  @Get()
  @Middleware(RouteTiming)
  public async slow() {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(RouteTiming)
  public failing() {
    throw new RouteTimingFailure('failed');
  }
}

function routeDuration(header: string | undefined): number | undefined {
  const match = /(?:^|,\s*)route;dur=([\d.]+)/.exec(header ?? '');
  return match ? Number(match[1]) : undefined;
}

describe('RouteTiming middleware', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(RouteTimingController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('adds the route execution time to Server-Timing', async () => {
    const res = await req().get('route-timing/slow');
    expect(res.status).to.eq(200);
    expect(routeDuration(res.header['server-timing'])).to.be.at.least(20);
  });

  it('adds no entry for a route that failed', async () => {
    const res = await req().get('route-timing/failing');
    expect(res.status).to.eq(500);
    expect(routeDuration(res.header['server-timing'])).to.eq(undefined);
  });

  it('appends its own header when ServerTiming collects no entries', async () => {
    const appended: Array<[string, string]> = [];
    const res = { locals: {}, headersSent: false, append: (name: string, value: string) => appended.push([name, value]) } as unknown as express.Response;
    const request = { storage: {} } as unknown as sRequest;
    const timing = new RouteTiming();

    await timing.onBefore(request, res);
    await timing.onAfter(request, res);

    expect(appended).to.have.length(1);
    expect(appended[0][0]).to.eq('Server-Timing');
    expect(routeDuration(appended[0][1])).to.be.a('number');
  });

  it('adds its entry to the ServerTiming entries when they are collected', async () => {
    const entries: IServerTimingEntry[] = [];
    const res = { locals: {}, headersSent: false, append: () => expect.fail('appended a header ServerTiming would overwrite') } as unknown as express.Response;
    const request = { storage: { serverTiming: entries } } as unknown as sRequest;
    const timing = new RouteTiming();

    await timing.onBefore(request, res);
    await timing.onAfter(request, res);

    expect(entries.map((e) => e.name)).to.deep.eq(['route']);
  });
});
