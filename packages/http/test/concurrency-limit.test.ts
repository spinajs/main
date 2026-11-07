import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import { configurationViolations, createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { appPort, httpApp, TestConfiguration } from './common.js';
import { BaseController, BasePath, ConcurrencyLimit, Controllers, Get, HttpServer, Ok, ServerMiddleware } from '../src/index.js';
import type { IMiddlewareContext, Response } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { serverApp } from './support/server-app.js';

/** A ConcurrencyLimit reading `http.concurrency` (absent when undefined) from a Configuration the http schema checked. */
async function middleware(concurrency: unknown) {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: concurrency === undefined ? {} : { http: { concurrency } } });
  return readingFrom(new ConcurrencyLimit(), container);
}

/** An app whose `/hold` requests wait until `release()`; `held` counts those that reached the route. */
function holdingApp(mw: ConcurrencyLimit) {
  const waiting: (() => void)[] = [];
  let held = 0;
  const app = serverApp(mw, (req, res) => {
    if (req.path !== '/hold') {
      res.json({ ok: true });
      return;
    }
    held++;
    waiting.push(() => res.json({ held: true }));
  });
  const server = http.createServer(app);
  return {
    listen: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    held: () => held,
    release: () => waiting.splice(0).forEach((send) => send()),
  };
}

function get(port: number, path: string): { done: Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>; abort: () => void } {
  let request!: http.ClientRequest;
  const done = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    request = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    request.on('error', reject);
  });
  return { done, abort: () => request.destroy() };
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ConcurrencyLimit', () => {
  afterEach(disposeTestApps);

  it('is off by default and mounts nothing', async () => {
    const mw = await middleware(undefined);
    expect(mw.isEnabled()).to.eq(false);
    expect(mw.Order).to.eq(2.6);
  });

  it('answers 503 with Retry-After over max, and lets requests in again once one finished', async () => {
    const mw = await middleware({ enabled: true, max: 2 });
    const app = holdingApp(mw);
    const port = await app.listen();
    try {
      const first = get(port, '/hold');
      const second = get(port, '/hold');
      await until(() => app.held() === 2);
      expect(mw.InFlight).to.eq(2);

      const refused = await get(port, '/probe').done;
      expect(refused.status).to.eq(503);
      expect(refused.headers['retry-after']).to.eq('1');
      expect(JSON.parse(refused.body)).to.deep.eq({ error: { code: 'overloaded', message: 'The server is busy, try again later' } });
      // a refused request is not counted
      expect(mw.InFlight).to.eq(2);

      app.release();
      expect((await first.done).status).to.eq(200);
      expect((await second.done).status).to.eq(200);
      await until(() => mw.InFlight === 0);

      expect((await get(port, '/probe').done).status).to.eq(200);
      await until(() => mw.InFlight === 0);
    } finally {
      app.release();
      await app.close();
    }
  });

  it('takes retryAfter from the configuration', async () => {
    const mw = await middleware({ enabled: true, max: 1, retryAfter: 5 });
    const app = holdingApp(mw);
    const port = await app.listen();
    try {
      const held = get(port, '/hold');
      await until(() => app.held() === 1);
      const refused = await get(port, '/probe').done;
      expect(refused.status).to.eq(503);
      expect(refused.headers['retry-after']).to.eq('5');
      app.release();
      await held.done;
    } finally {
      app.release();
      await app.close();
    }
  });

  it('frees the slot of a request whose client went away', async () => {
    const mw = await middleware({ enabled: true, max: 1 });
    const app = holdingApp(mw);
    const port = await app.listen();
    try {
      const gone = get(port, '/hold');
      gone.done.catch(() => undefined);
      await until(() => app.held() === 1);
      expect(mw.InFlight).to.eq(1);

      gone.abort();
      await until(() => mw.InFlight === 0);
      expect((await get(port, '/probe').done).status).to.eq(200);
    } finally {
      app.release();
      await app.close();
    }
  });

  it('the schema refuses a max below 1 and a retryAfter below 0', async () => {
    const violations = (concurrency: unknown) => configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { concurrency } } });
    expect(await violations({ max: 0 })).to.include('http.concurrency.max');
    expect(await violations({ retryAfter: -1 })).to.include('http.concurrency.retryAfter');
    expect(await violations({ enabled: true, max: 10, retryAfter: 0 })).to.deep.eq([]);
  });
});

let releaseHeld: () => void = () => undefined;
let heldEntered: () => void = () => undefined;

@BasePath('conc')
class ConcurrencyController extends BaseController {
  @Get()
  public async hold() {
    const released = new Promise<void>((resolve) => (releaseHeld = resolve));
    heldEntered();
    await released;
    return new Ok({ held: true });
  }

  @Get()
  public fail() {
    throw new Forbidden('refused by the route');
  }
}

/** Answers early, after ConcurrencyLimit counted the request. */
class LaterAnswer extends ServerMiddleware {
  public Order = 3.5;

  public onBefore({ req }: IMiddlewareContext): Response | undefined {
    return req.headers['x-answer'] ? new Ok({ answered: 'later' }) : undefined;
  }
}

class ConcurrencyConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { http: Record<string, unknown> }).http.concurrency = { enabled: true, max: 1 };
  }
}

describe('ConcurrencyLimit in HttpServer', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: ConcurrencyConfiguration,
      register: (c) => {
        c.register(ConcurrencyController).as(BaseController);
        c.register(LaterAnswer).as(ServerMiddleware);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  const limit = () => DI.get(ConcurrencyLimit)!;
  const free = () => until(() => limit().InFlight === 0);
  const fetch = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: appPort(), path, agent: false, headers: { Accept: 'application/json', ...headers } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        })
        .on('error', reject);
    });

  it('frees the slot of an error reply, a 404 and a later middleware answer', async () => {
    expect((await fetch('/conc/fail')).status).to.eq(403);
    await free();
    expect((await fetch('/conc/nothing-here')).status).to.eq(404);
    await free();
    expect((await fetch('/conc/fail', { 'x-answer': '1' })).status).to.eq(200);
    await free();
  });

  it('refuses with a request id while the slot is held', async () => {
    const entered = new Promise<void>((resolve) => (heldEntered = resolve));
    const held = fetch('/conc/hold');
    await entered;

    const refused = await fetch('/conc/fail');
    expect(refused.status).to.eq(503);
    expect(refused.headers['x-request-id']).to.be.a('string');
    expect(limit().InFlight).to.eq(1);

    releaseHeld();
    expect((await held).status).to.eq(200);
    await free();
  });
});
