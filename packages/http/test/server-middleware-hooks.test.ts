import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { Forbidden, InvalidOperation } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import type { TestApp, TestAppOptions } from '@spinajs/testing';
import type express from 'express';

import { appPort, httpApp, req, TestConfiguration } from './common.js';
import {
  AccessLog,
  BaseController,
  BasePath,
  Controllers,
  defaultMiddlewares,
  ErrorHandlerMiddleware,
  Get,
  HttpServer,
  Middleware,
  NotFound,
  NotFoundMiddleware,
  Ok,
  Post,
  RequestStorage,
  RouteMiddleware,
  RouteTiming,
  ServerMiddleware,
  SlowRequestWarning,
} from '../src/index.js';
import type { IFinishContext, IMiddlewareContext, IReplyContext, IRouteOutcome, Request, Response } from '../src/index.js';

const PARTNER = 'https://partner.example.test';

const calls: string[] = [];
const arounds: string[] = [];
const resolved: string[] = [];
const state: Record<string, unknown> = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms; calls: ${calls.join(', ')}`);
    await sleep(5);
  }
}

const errorName = (error: unknown) => (error === undefined ? '-' : (error as Error).constructor.name);

/** Records each hook as `<label>:<hook>`; onAfter adds the reply status and error class and appends `x-server-after`. */
abstract class Recording extends ServerMiddleware {
  protected abstract readonly label: string;

  public async onBefore(ctx: IMiddlewareContext): Promise<void | Response> {
    calls.push(`${this.label}:before`);
    if (this.label === 'a') {
      state.beforePath = ctx.path;
      state.beforeRoute = ctx.route?.Method;
      state.beforeController = ctx.controller?.constructor.name;
    }
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    calls.push(`${this.label}:after:${ctx.response.statusCode}:${errorName(ctx.error)}`);
    ctx.res.append('x-server-after', this.label);
    if (this.label === 'a') {
      state.afterPath = ctx.path;
      state.afterRoute = ctx.route?.Method;
    }
  }

  public onFinish(ctx: IFinishContext): void {
    calls.push(`${this.label}:finish:${ctx.aborted}`);
    if (this.label === 'a') {
      state.finishPath = ctx.path;
    }
  }
}

class EarlyRec extends Recording {
  protected readonly label = 'early';
  public Order = -5;
}

class SrvA extends Recording {
  protected readonly label = 'a';
  public Order = 10;
}

class TieFirst extends Recording {
  protected readonly label = 'tie1';
  public Order = 15;

  // registered before TieSecond, but finishes resolving after it
  public async resolve(): Promise<void> {
    await sleep(50);
    resolved.push(this.label);
    await super.resolve();
  }
}

class TieSecond extends Recording {
  protected readonly label = 'tie2';
  public Order = 15;

  public async resolve(): Promise<void> {
    resolved.push(this.label);
    await super.resolve();
  }
}

class SrvB extends Recording {
  protected readonly label = 'b';
  public Order = 20;
}

class SrvHandler extends ServerMiddleware {
  public Order = 25;

  public handler(): express.RequestHandler {
    return (_req, res, next) => {
      calls.push('handler');
      res.setHeader('x-handler', 'mounted');
      next();
    };
  }
}

class SrvDisabled extends ServerMiddleware {
  public Order = 26;

  public isEnabled(): boolean {
    return false;
  }

  public async onBefore(): Promise<void> {
    calls.push('disabled');
  }

  public onFinish(): void {
    calls.push('disabled:finish');
  }
}

class SrvAnswer extends Recording {
  protected readonly label = 'answer';
  public Order = 30;

  public async onBefore(ctx: IMiddlewareContext): Promise<void | Response> {
    await super.onBefore(ctx);
    if (ctx.req.headers['x-answer']) {
      return new Ok({ answered: 'server' });
    }
  }
}

class SrvThrow extends ServerMiddleware {
  public Order = 31;

  public async onBefore(ctx: IMiddlewareContext): Promise<void> {
    if (ctx.req.headers['x-throw']) {
      throw new Forbidden('refused by a server middleware');
    }
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    if (ctx.req.headers['x-throw']) {
      calls.push('throw:after');
    }
  }
}

class SrvAround extends ServerMiddleware {
  public Order = 5;

  public async onAround(invocation: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    arounds.push(`start:${invocation.route === undefined}`);
    const outcome = await proceed();
    arounds.push(`end:${outcome.reply?.status ?? '-'}:${errorName(outcome.error)}`);
  }
}

class SrvThrowAfter extends ServerMiddleware {
  public Order = 12;

  public async onAfter(ctx: IReplyContext): Promise<void> {
    if (ctx.req.headers['x-throw-after']) {
      throw new Error('refused by a server onAfter');
    }
  }
}

class RouteRec extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    calls.push('route:before');
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    calls.push(`route:after:${ctx.response.statusCode}:${errorName(ctx.error)}`);
  }

  public onFinish(ctx: IFinishContext): void {
    calls.push(`route:finish:${ctx.aborted}`);
  }
}

class CustomNotFound extends NotFoundMiddleware {
  public reply(req: Request) {
    if (req.originalUrl.includes('custom-404')) {
      return new NotFound({ custom: 'not found' });
    }
    if (req.originalUrl.includes('empty-404')) {
      return undefined as unknown as Error;
    }
    return super.reply(req);
  }
}

class RecordingErrorHandler extends ErrorHandlerMiddleware {
  public async reply(error: unknown, req: Request): Promise<Response> {
    state.errorStorage = req.storage;
    const response = await super.reply(error, req);
    response.setHeader('x-error-handler', 'custom');
    return response;
  }
}

@BasePath('srv')
class ServerHooksController extends BaseController {
  @Get()
  @Middleware(RouteRec)
  public ok() {
    calls.push('action');
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(RouteRec)
  public fail() {
    throw new Forbidden('refused by the route');
  }

  @Post()
  public echo() {
    return new Ok({ echoed: true });
  }

  @Post()
  public limited() {
    return new Ok({ limited: false });
  }

  @Get()
  @Middleware(RouteTiming)
  public timed() {
    return new Ok({ timed: true });
  }

  @Get()
  public big() {
    return new Ok({ text: 'x'.repeat(5000) });
  }
}

class ServerHooksConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const httpConfig = (this.Config as { http: Record<string, unknown> }).http;
    httpConfig.cors = { origins: [PARTNER] };
    httpConfig.bodyLimits = [{ path: '/srv/limited', limit: '8b' }];
    httpConfig.compression = { enabled: false };
    httpConfig.middlewares = defaultMiddlewares();
  }
}

/** A GET without decompression: the headers as sent. */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: 'localhost', port: appPort(), path, method: 'GET', headers }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

const header = (res: { header: unknown }, name: string) => (res.header as Record<string, string | undefined>)[name];

const BEFORE_ALL = ['early:before', 'a:before', 'tie1:before', 'tie2:before', 'b:before', 'handler', 'answer:before'];
const afterAll = (status: number, error: string) => [`answer:after:${status}:${error}`, `b:after:${status}:${error}`, `tie2:after:${status}:${error}`, `tie1:after:${status}:${error}`, `a:after:${status}:${error}`, `early:after:${status}:${error}`];
const FINISH_ALL = ['answer:finish:false', 'b:finish:false', 'tie2:finish:false', 'tie1:finish:false', 'a:finish:false', 'early:finish:false'];

describe('Server middleware hooks', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: ServerHooksConfiguration,
      register: (c) => {
        c.register(ServerHooksController).as(BaseController);
        for (const type of [EarlyRec, SrvA, SrvThrowAfter, TieFirst, TieSecond, SrvB, SrvHandler, SrvDisabled, SrvAnswer, SrvThrow, SrvAround]) {
          c.register(type).as(ServerMiddleware);
        }
        c.register(CustomNotFound).as(NotFoundMiddleware);
        c.register(RecordingErrorHandler).as(ErrorHandlerMiddleware);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    calls.length = 0;
    arounds.length = 0;
    for (const key of Object.keys(state)) delete state[key];
  });

  it('runs server onBefore in ascending Order before routing, ties in registration order, handler() at its Order', async () => {
    const res = await req().get('srv/ok').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(200);
    expect(header(res, 'x-handler')).to.eq('mounted');
    expect(calls).to.deep.eq([...BEFORE_ALL, 'route:before', 'action', 'route:after:200:-', ...afterAll(200, '-'), 'route:finish:false', ...FINISH_ALL]);
  });

  it('mounts equal Orders in registration order, not in the order their resolve() finished', async () => {
    expect(resolved).to.deep.eq(['tie2', 'tie1']);

    await req().get('srv/ok').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));

    const ties = calls.filter((c) => c.startsWith('tie'));
    expect(ties).to.deep.eq(['tie1:before', 'tie2:before', 'tie2:after:200:-', 'tie1:after:200:-', 'tie2:finish:false', 'tie1:finish:false']);
  });

  it('gives server onAfter and onFinish the matched route', async () => {
    await req().get('srv/ok').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));

    expect(state).to.include({ afterPath: 'http:GET /srv/ok', afterRoute: 'ok', finishPath: 'http:GET /srv/ok' });
  });

  it('gives server onBefore the route the request will match, looked up before routing', async () => {
    await req().get('srv/ok').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));
    expect(state).to.include({ beforePath: 'http:GET /srv/ok', beforeRoute: 'ok', beforeController: 'ServerHooksController' });

    for (const key of Object.keys(state)) delete state[key];
    calls.length = 0;
    await req().get('srv/missing').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));
    expect(state.beforeRoute).to.eq(undefined);
    expect(state.beforePath).to.eq(undefined);
  });

  it('runs server onAfter after the route onAfter on an error reply, and its header reaches the client', async () => {
    const res = await req().get('srv/fail').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(403);
    expect(calls).to.deep.eq([...BEFORE_ALL, 'route:before', 'route:after:403:Forbidden', ...afterAll(403, 'Forbidden'), 'route:finish:false', ...FINISH_ALL]);
    expect(header(res, 'x-server-after')).to.eq('answer, b, tie2, tie1, a, early');
  });

  it('sends the 404 through the reply pipeline: server onAfter sees it, the replaced handlers answer it', async () => {
    const res = await req().get('srv/missing').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(404);
    expect(calls).to.deep.eq([...BEFORE_ALL, ...afterAll(404, 'ResourceNotFound'), ...FINISH_ALL]);
    expect(header(res, 'x-server-after')).to.eq('answer, b, tie2, tie1, a, early');
    expect(header(res, 'x-error-handler')).to.eq('custom');
  });

  it('keeps NotFoundMiddleware replaceable through DI', async () => {
    const res = await req().get('srv/custom-404').set('Accept', 'application/json');

    expect(res.status).to.eq(404);
    expect(res.body).to.deep.eq({ custom: 'not found' });
    expect(header(res, 'x-server-after')).to.eq('answer, b, tie2, tie1, a, early');
    expect(header(res, 'x-error-handler')).to.eq(undefined);
    expect(calls).to.include('a:after:404:-');
  });

  it('answers with the Response a server onBefore returned: the route never runs, entered server onAfter see it', async () => {
    const res = await req().get('srv/ok').set('Accept', 'application/json').set('x-answer', '1');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ answered: 'server' });
    expect(header(res, 'x-server-after')).to.eq('answer, b, tie2, tie1, a, early');
    expect(calls).to.deep.eq([...BEFORE_ALL, ...afterAll(200, '-'), ...FINISH_ALL]);
  });

  it('turns the reply into an error reply when a server onAfter throws (D8): route reply, 404 and early answer', async () => {
    for (const [path, headers, status, error] of [
      ['srv/ok', {}, 200, '-'],
      ['srv/missing', {}, 404, 'ResourceNotFound'],
      ['srv/ok', { 'x-answer': '1' }, 200, '-'],
    ] as const) {
      calls.length = 0;
      let request = req().get(path).set('Accept', 'application/json').set('x-throw-after', '1');
      for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
      const res = await request;
      await until(() => calls.includes('early:finish:false'));

      expect(res.status, path).to.eq(500);
      expect(calls, path).to.include(`tie1:after:${status}:${error}`);
      expect(calls, path).to.include('a:after:500:Error');
      expect(calls.filter((c) => c.startsWith('tie1:after')), path).to.have.length(1);
    }
  });

  it('answers the framework 404 when a NotFoundMiddleware replacement returns nothing', async () => {
    const res = await req().get('srv/empty-404').set('Accept', 'application/json');

    expect(res.status).to.eq(404);
    expect(header(res, 'x-error-handler')).to.eq('custom');
    expect(header(res, 'x-server-after')).to.eq('answer, b, tie2, tie1, a, early');
  });

  it('answers a throwing server onBefore with the global error answer; the thrower is not entered', async () => {
    const res = await req().get('srv/ok').set('Accept', 'application/json').set('x-throw', '1');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(403);
    expect(calls).to.deep.eq([...BEFORE_ALL, ...afterAll(403, 'Forbidden'), ...FINISH_ALL]);
    expect(calls).to.not.include('throw:after');
  });

  it('runs server onAfter on a CORS preflight answered by a server middleware', async () => {
    const res = await req().options('srv/ok').set('Origin', PARTNER).set('Access-Control-Request-Method', 'POST');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(204);
    expect(header(res, 'access-control-allow-origin')).to.eq(PARTNER);
    expect(header(res, 'x-server-after')).to.eq('early');
    expect(calls).to.deep.eq(['early:before', 'early:after:204:-', 'early:finish:false']);
  });

  it('runs server onFinish for a static file, without onAfter', async () => {
    const res = await req().get('public/index.html');
    await until(() => calls.includes('early:finish:false'));

    expect(res.status).to.eq(200);
    expect(header(res, 'x-server-after')).to.eq(undefined);
    expect(calls).to.deep.eq([...BEFORE_ALL, ...FINISH_ALL]);
  });

  it('wraps the request with a server onAround: proceed() resolves with the reply, or the error it answers', async () => {
    await req().get('srv/ok').set('Accept', 'application/json');
    await until(() => arounds.length === 2);
    await req().get('srv/fail').set('Accept', 'application/json');
    await until(() => arounds.length === 4);
    await req().get('srv/missing').set('Accept', 'application/json');
    await until(() => arounds.length === 6);

    expect(arounds).to.deep.eq(['start:false', 'end:200:-', 'start:false', 'end:403:Forbidden', 'start:true', 'end:404:ResourceNotFound']);
  });

  it('does not resolve the deprecated RequestStorage as a server middleware', async () => {
    const mounted = ((await app.resolve(HttpServer)) as unknown as { Middlewares: ServerMiddleware[] }).Middlewares;

    expect(mounted.some((m) => m instanceof SrvA)).to.eq(true);
    expect(mounted.some((m) => m instanceof RequestStorage)).to.eq(false);
  });

  it('mounts nothing for a middleware whose isEnabled() is false', async () => {
    await req().get('srv/ok').set('Accept', 'application/json');
    await until(() => calls.includes('early:finish:false'));

    expect(calls).to.not.include('disabled');
    expect(calls).to.not.include('disabled:finish');
  });

  it('gives a body parser failure the request storage', async () => {
    const res = await req().post('srv/echo').set('Content-Type', 'application/json').set('Accept', 'application/json').send('{"broken": ');

    expect(res.status).to.eq(400);
    expect(state.errorStorage).to.be.an('object');
  });

  it('gives a body over its http.bodyLimits limit the request storage', async () => {
    const res = await req().post('srv/limited').set('Content-Type', 'application/json').set('Accept', 'application/json').send({ much: 'more than eight bytes' });

    expect(res.status).to.eq(413);
    expect(state.errorStorage).to.be.an('object');
  });

  it('sends Server-Timing with the route entry of RouteTiming and the total, and x-response-time', async () => {
    const res = await req().get('srv/timed').set('Accept', 'application/json');

    expect(res.status).to.eq(200);
    expect(header(res, 'server-timing')).to.match(/^route;dur=[\d.]+, total;dur=\d+$/);
    expect(header(res, 'x-response-time')).to.match(/^\d+$/);
  });

  it('does not compress with http.compression.enabled false and the shipped http.middlewares', async () => {
    const res = await rawGet('/srv/big', { Accept: 'application/json', 'Accept-Encoding': 'gzip' });

    expect(res.status).to.eq(200);
    expect(res.headers['content-encoding']).to.eq(undefined);
  });
});

describe('Server middleware hooks: compression enabled', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(ServerHooksController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('compresses through the Compression middleware handler()', async () => {
    const res = await rawGet('/srv/big', { Accept: 'application/json', 'Accept-Encoding': 'gzip' });

    expect(res.status).to.eq(200);
    expect(res.headers['content-encoding']).to.eq('gzip');
  });
});

const ONCE_MODEL = { serialized: 'once' };

class NoopAround extends ServerMiddleware {
  public Order = 5;

  public async onAround(_invocation: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    await proceed();
  }
}

@BasePath('srv-once')
class SerializeOnceController extends BaseController {
  @Get()
  public model() {
    return new Ok(ONCE_MODEL);
  }
}

describe('Server middleware hooks: an onAround that does not read the reply', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => {
        c.register(SerializeOnceController).as(BaseController);
        c.register(NoopAround).as(ServerMiddleware);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('serializes a JSON reply once', async () => {
    const stringify = JSON.stringify;
    let serialized = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      if (value === ONCE_MODEL) serialized++;
      return (stringify as (...args: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    try {
      const res = await req().get('srv-once/model').set('Accept', 'application/json');
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq(ONCE_MODEL);
    } finally {
      JSON.stringify = stringify;
    }
    expect(serialized).to.eq(1);
  });
});

describe('Server middleware hooks: aborted requests', () => {
  function recording<T extends AccessLog | SlowRequestWarning>(mw: T, values: Record<string, unknown>) {
    const lines: unknown[][] = [];
    const record = (...args: unknown[]) => lines.push(args);
    for (const [key, value] of Object.entries({ ...values, Log: { info: record, warn: record } })) {
      Object.defineProperty(mw, key, { value });
    }
    return lines;
  }

  const ctxOf = () => {
    const req = { method: 'GET', originalUrl: '/slow', headers: {}, storage: { requestId: 'r1' } } as unknown as Request;
    return { req, res: { statusCode: 200, locals: {} } as unknown as express.Response, storage: req.storage };
  };

  it('AccessLog logs an aborted request, marked aborted and without a status', () => {
    const mw = new AccessLog();
    const lines = recording(mw, { Enabled: true });
    const ctx = ctxOf();
    mw.onBefore(ctx);
    mw.onFinish({ ...ctx, aborted: true });

    expect(lines).to.have.length(1);
    expect(lines[0][0]).to.include({ aborted: true, requestId: 'r1' });
    expect(lines[0][0]).to.not.have.property('status');
  });

  it('AccessLog logs the sent status of a streamed reply the client closed, marked aborted', () => {
    const mw = new AccessLog();
    const lines = recording(mw, { Enabled: true });
    const ctx = ctxOf();
    Object.defineProperty(ctx.res, 'headersSent', { value: true });
    mw.onBefore(ctx);
    mw.onFinish({ ...ctx, aborted: true });

    expect(lines).to.have.length(1);
    expect(lines[0][0]).to.include({ aborted: true, status: 200, requestId: 'r1' });
    expect(lines[0][1]).to.contain('${status}');
  });

  it('SlowRequestWarning ignores an aborted request', () => {
    const mw = new SlowRequestWarning();
    const lines = recording(mw, { Enabled: true, ThresholdMs: 0 });
    const ctx = ctxOf();
    mw.onBefore(ctx);
    mw.onFinish({ ...ctx, aborted: true });
    mw.onFinish({ ...ctx, aborted: false });

    expect(lines).to.have.length(1);
  });
});

describe('Server middleware hooks: the removed before()/after()', function () {
  this.timeout(15000);

  class StillBefore extends ServerMiddleware {
    public Order = 1;

    public before() {
      return (_req: Request, _res: express.Response, next: express.NextFunction) => next();
    }
  }

  class StillAfter extends ServerMiddleware {
    public Order = 1;

    public after() {
      return null;
    }
  }

  class StillAfterNotFound extends NotFoundMiddleware {
    public after() {
      return null;
    }
  }

  async function bootError(register: NonNullable<TestAppOptions['register']>): Promise<unknown> {
    const app = await httpApp({ register });
    try {
      return await app.resolve(HttpServer).then(
        () => undefined,
        (err: unknown) => err,
      );
    } finally {
      await app.dispose();
    }
  }

  it('fails the boot for a server middleware that still defines before() or after(), naming it', async () => {
    for (const type of [StillBefore, StillAfter]) {
      const err = await bootError((c) => c.register(type).as(ServerMiddleware));
      expect(err, type.name).to.be.instanceOf(InvalidOperation);
      expect((err as Error).message).to.contain(type.name);
      expect((err as Error).message).to.contain('onBefore');
    }
  });

  it('fails the boot for a NotFoundMiddleware replacement that still defines after()', async () => {
    const err = await bootError((c) => c.register(StillAfterNotFound).as(NotFoundMiddleware));
    expect(err).to.be.instanceOf(InvalidOperation);
    expect((err as Error).message).to.contain('StillAfterNotFound');
    expect((err as Error).message).to.contain('reply()');
  });
});
