import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import http from 'node:http';
import { configurationViolations, createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { ConcurrencyLimit } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { serverApp } from './support/server-app.js';

chai.use(chaiHttp);

/** A ConcurrencyLimit reading `http.concurrency` (absent when undefined) from a Configuration the http schema checked. */
async function middleware(concurrency: unknown) {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: concurrency === undefined ? {} : { http: { concurrency } } });
  return readingFrom(new ConcurrencyLimit(), container);
}

const header = (res: { header: unknown }, name: string) => (res.header as Record<string, string | undefined>)[name];

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
    expect(mw.Order).to.eq(-0.4);
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
    const mw = await middleware({ enabled: true, max: 0, retryAfter: 5 });
    const res = await chai.request(serverApp(mw, (_req, res) => res.json({}))).get('/probe');
    expect(res.status).to.eq(503);
    expect(header(res, 'retry-after')).to.eq('5');
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

  it('the schema refuses a max below 0 and a retryAfter below 0', async () => {
    const violations = (concurrency: unknown) => configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { concurrency } } });
    expect(await violations({ max: -1 })).to.include('http.concurrency.max');
    expect(await violations({ retryAfter: -1 })).to.include('http.concurrency.retryAfter');
    expect(await violations({ enabled: true, max: 10, retryAfter: 0 })).to.deep.eq([]);
  });
});
