import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import sinon from 'sinon';
import { once } from 'node:events';
import http from 'node:http';
import { DI } from '@spinajs/di';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';
import type { TestApp } from '@spinajs/testing';
import { configurationViolations, createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { appPort, httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, Deadline, DeadlineMiddleware, Get, HttpServer, Ok, Req, RequestDeadline } from '../src/index.js';
import type { IActionLocalStoregeContext, Request } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { serverApp } from './support/server-app.js';

chai.use(chaiHttp);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms`);
    await sleep(5);
  }
}

/** A RequestDeadline reading `http.deadline` (absent when undefined) from a Configuration the http schema checked. */
async function middleware(deadline: unknown) {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: deadline === undefined ? {} : { http: { deadline } } });
  const mw = readingFrom(new RequestDeadline(), container);
  Object.defineProperty(mw, 'Log', { value: { warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() } });
  return mw;
}

const errorOf = (res: { body: unknown }) => (res.body as { error: { code: string; message: string } }).error;

/** A fake route middleware context: `res.locals` is all the deadline needs from the response before it fires. */
const fakeContext = () => {
  const storage = {} as IActionLocalStoregeContext;
  return { req: {} as never, res: { locals: {} } as never, storage };
};

describe('RequestDeadline', () => {
  afterEach(async () => {
    sinon.restore();
    await disposeTestApps();
  });

  it('is off by default and mounts nothing', async () => {
    const mw = await middleware(undefined);
    expect(mw.isEnabled()).to.eq(false);
    expect(mw.Order).to.eq(-0.3);
  });

  it('puts an AbortSignal and the deadline in the request storage; a reply in time leaves the signal alone', async () => {
    const mw = await middleware({ enabled: true, ms: 1000 });
    let seen: IActionLocalStoregeContext | undefined;
    const before = Date.now();
    const app = serverApp(mw, (req, res) => {
      seen = (req as unknown as Request).storage;
      res.json({ ok: true });
    });

    const res = await chai.request(app).get('/probe');
    expect(res.status).to.eq(200);
    expect(seen!.signal).to.be.instanceOf(AbortSignal);
    expect(seen!.deadline).to.be.within(before + 1000, Date.now() + 1000);
    await sleep(1100);
    expect(seen!.signal!.aborted).to.eq(false);
  });

  it('answers 504 when nothing was sent by the deadline, and aborts the signal with a TimeoutError', async () => {
    const mw = await middleware({ enabled: true, ms: 50 });
    let seen: IActionLocalStoregeContext | undefined;
    const app = serverApp(mw, (req) => {
      seen = (req as unknown as Request).storage;
    });

    const res = await chai.request(app).get('/probe');
    expect(res.status).to.eq(504);
    expect(errorOf(res)).to.deep.eq({ code: 'deadline_exceeded', message: 'The request took too long' });
    expect(seen!.signal!.aborted).to.eq(true);
    expect((seen!.signal!.reason as DOMException).name).to.eq('TimeoutError');
  });

  it('aborts the signal when the client goes away', async () => {
    const mw = await middleware({ enabled: true, ms: 10000 });
    let seen: IActionLocalStoregeContext | undefined;
    const server = http.createServer(
      serverApp(mw, (req) => {
        seen = (req as unknown as Request).storage;
      }),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const request = http.get({ host: '127.0.0.1', port: (server.address() as { port: number }).port, path: '/probe', agent: false });
      request.on('error', () => undefined);
      await until(() => seen !== undefined);
      request.destroy();
      await until(() => seen!.signal!.aborted);
      expect((seen!.signal!.reason as DOMException).name).to.eq('AbortError');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('the schema refuses an ms below 1', async () => {
    const violations = (deadline: unknown) => configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { deadline } } });
    expect(await violations({ ms: 0 })).to.include('http.deadline.ms');
    expect(await violations({ enabled: true, ms: 1 })).to.deep.eq([]);
  });
});

describe('@Deadline', () => {
  it('sets a deadline of its own when the server has none, and clears it on finish', async () => {
    const mw = new DeadlineMiddleware(50);
    const ctx = fakeContext();
    const before = Date.now();

    mw.onBefore(ctx);
    expect(ctx.storage.signal).to.be.instanceOf(AbortSignal);
    expect(ctx.storage.deadline).to.be.within(before + 50, Date.now() + 50);

    mw.onFinish({ ...ctx, aborted: false });
    await sleep(100);
    expect(ctx.storage.signal!.aborted).to.eq(false);
  });

  it('only shortens a deadline', async () => {
    const ctx = fakeContext();
    new DeadlineMiddleware(200).onBefore(ctx);
    const signal = ctx.storage.signal;
    const first = ctx.storage.deadline!;

    new DeadlineMiddleware(5000).onBefore(ctx);
    expect(ctx.storage.deadline).to.eq(first);

    new DeadlineMiddleware(20).onBefore(ctx);
    expect(ctx.storage.deadline).to.be.lessThan(first);
    expect(ctx.storage.signal).to.eq(signal);

    new DeadlineMiddleware(1).onFinish({ ...ctx, aborted: false });
  });

  it('refuses a deadline that is not a positive number', () => {
    expect(() => Deadline(0)).to.throw();
    expect(() => Deadline(Number.NaN)).to.throw();
  });
});

let lateReplied = false;
let lateThrown = false;

@BasePath('deadline')
class DeadlineController extends BaseController {
  @Get()
  public async late(@Req() req: Request) {
    await once(req.storage.signal!, 'abort');
    await sleep(20);
    lateReplied = true;
    return new Ok({ late: true });
  }

  @Get()
  public async rejects(@Req() req: Request) {
    await new Promise((_resolve, reject) => req.storage.signal!.addEventListener('abort', () => reject(req.storage.signal!.reason as Error)));
  }

  @Get()
  public async rejected(@Req() req: Request) {
    try {
      await new Promise((_resolve, reject) => req.storage.signal!.addEventListener('abort', () => reject(req.storage.signal!.reason as Error)));
    } finally {
      await sleep(20);
      lateThrown = true;
    }
  }

  @Get()
  public remaining(@Req() req: Request) {
    return new Ok({ remaining: req.storage.deadline! - Date.now() });
  }

  @Get()
  @Deadline(100)
  public shorter(@Req() req: Request) {
    return new Ok({ remaining: req.storage.deadline! - Date.now() });
  }

  @Get()
  @Deadline(60000)
  public longer(@Req() req: Request) {
    return new Ok({ remaining: req.storage.deadline! - Date.now() });
  }
}

class DeadlineConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { http: Record<string, unknown> }).http.deadline = { enabled: true, ms: 300 };
  }
}

describe('RequestDeadline in HttpServer', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: DeadlineConfiguration,
      register: (c) => c.register(DeadlineController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  afterEach(() => sinon.restore());

  const get = (path: string) => req().get(path).set('Accept', 'application/json');
  const remaining = (res: { body: unknown }) => (res.body as { remaining: number }).remaining;

  it('answers 504 and drops the action reply that comes after it', async () => {
    const error = sinon.spy(DI.resolve(Log, ['http']), 'error');
    lateReplied = false;

    const res = await get('deadline/late');
    expect(res.status).to.eq(504);
    expect(errorOf(res).code).to.eq('deadline_exceeded');

    await until(() => lateReplied);
    await sleep(50);
    expect(error.args.map((a) => String(a[1] ?? a[0]))).to.deep.eq([]);
  });

  it('does not log an action that fails after the 504 as an error', async () => {
    const error = sinon.spy(DI.resolve(Log, ['http']), 'error');
    lateThrown = false;

    const res = await get('deadline/rejected');
    expect(res.status).to.eq(504);

    await until(() => lateThrown);
    await sleep(50);
    expect(error.args.map((a) => String(a[1] ?? a[0]))).to.deep.eq([]);
  });

  it('answers 504 with the request id a later server middleware set', async () => {
    const res = await get('deadline/rejects');
    expect(res.status).to.eq(504);
    expect((res.header as Record<string, string | undefined>)['x-request-id']).to.be.a('string');
  });

  it('gives the action the server deadline', async () => {
    const res = await get('deadline/remaining');
    expect(res.status).to.eq(200);
    expect(remaining(res)).to.be.within(1, 300);
  });

  it('@Deadline shortens the server deadline but never lengthens it', async () => {
    expect(remaining(await get('deadline/shorter'))).to.be.within(1, 100);
    expect(remaining(await get('deadline/longer'))).to.be.within(1, 300);
  });

  it('the server keeps serving after deadlines fired', async () => {
    expect(appPort()).to.be.a('number');
    expect((await get('deadline/remaining')).status).to.eq(200);
  });
});
