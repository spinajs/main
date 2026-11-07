import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import sinon from 'sinon';
import { DI, NewInstance } from '@spinajs/di';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log-common';
import type { TestApp } from '@spinajs/testing';
import type express from 'express';

import { appPort, httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Created, Get, HttpServer, Middleware, Ok, OnError, RouteMiddleware, Unauthorized } from '../src/index.js';
import type { IFinishContext, IMiddlewareContext, IReplyContext, MiddlewareStage, Response } from '../src/index.js';

const calls: string[] = [];
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

class Handled extends Error {}

/** Records every hook as `<label>:<hook>`; onAfter adds the reply status and the error class. */
@NewInstance()
class Rec extends RouteMiddleware {
  constructor(protected readonly label: string) {
    super();
  }

  public async onBefore(_ctx: IMiddlewareContext): Promise<void> {
    calls.push(`${this.label}:before`);
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    calls.push(`${this.label}:after:${ctx.response.statusCode}:${errorName(ctx.error)}`);
  }

  public onFinish(ctx: IFinishContext): void {
    calls.push(`${this.label}:finish:${ctx.aborted}`);
  }
}

@NewInstance()
class OuterRec extends Rec {
  public override readonly Stage: MiddlewareStage = 'outer';
}

class ReplaceData extends RouteMiddleware {
  public async onAfter(ctx: IReplyContext): Promise<void> {
    ctx.response.data = { replaced: true, was: await ctx.response.data };
  }
}

class ReplaceResponse extends RouteMiddleware {
  public async onAfter(ctx: IReplyContext): Promise<void> {
    ctx.response = new Created({ replacement: true });
  }
}

class SetHeader extends RouteMiddleware {
  public async onAfter(ctx: IReplyContext): Promise<void> {
    ctx.res.setHeader('X-After', `${ctx.response.statusCode}`);
  }
}

class OverrideHeaders extends RouteMiddleware {
  public async onAfter(ctx: IReplyContext): Promise<void> {
    ctx.res.setHeader('X-Version', 'from-res');
    ctx.response.setHeader('X-Kind', 'from-response');
  }
}

class AnswerEarly extends RouteMiddleware {
  public async onBefore(): Promise<Response> {
    calls.push('answer:before');
    return new Ok({ early: true });
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    calls.push(`answer:after:${ctx.response.statusCode}:${errorName(ctx.error)}`);
  }
}

class ThrowBefore extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    throw new InvalidArgument('refused in onBefore');
  }

  public async onAfter(): Promise<void> {
    calls.push('throw-before:after');
  }

  public onFinish(): void {
    calls.push('throw-before:finish');
  }
}

@NewInstance()
class ThrowAfter extends RouteMiddleware {
  constructor(protected readonly label: string) {
    super();
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    calls.push(`${this.label}:after:${ctx.response.statusCode}:${errorName(ctx.error)}`);
    throw new Forbidden(`${this.label} refused the reply`);
  }
}

class AlsProbe extends RouteMiddleware {
  public async onBefore(ctx: IMiddlewareContext): Promise<void> {
    state.beforeStore = DI.resolve(AsyncLocalStorage).getStore() === ctx.storage;
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    const store = DI.resolve(AsyncLocalStorage).getStore() as Record<string, unknown> | undefined;
    state.afterStore = store !== undefined && store === (ctx.storage as unknown);
    state.afterMarker = store?.marker;
  }
}

class CtxProbe extends RouteMiddleware {
  public async onBefore(ctx: IMiddlewareContext): Promise<void> {
    state.beforeCtx = { route: String(ctx.route?.Method), controller: ctx.controller?.constructor.name, path: ctx.path, storage: ctx.storage === (ctx.req as unknown as { storage: unknown }).storage };
  }
}

class SlowBefore extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    await sleep(300);
  }
}

class FinishOnly extends RouteMiddleware {
  public onFinish(ctx: IFinishContext): void {
    calls.push(`finish-only:${ctx.aborted}`);
  }
}

class CachePublic extends RouteMiddleware {
  public async onAfter({ res, error }: IReplyContext): Promise<void> {
    if (error === undefined) res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}

class SameHeader extends RouteMiddleware {
  public async onBefore({ res }: IMiddlewareContext): Promise<void> {
    res.setHeader('X-V', 'hook');
  }

  public async onAfter({ res }: IReplyContext): Promise<void> {
    res.setHeader('X-V', 'hook');
  }
}

class RefuseBefore extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    throw new InvalidArgument('refused');
  }
}

@BasePath('hooks')
class HooksController extends BaseController {
  @Get()
  @Middleware(OuterRec, 'outer')
  @Middleware(Rec, 'i2')
  @Middleware(Rec, 'i1')
  public ok() {
    calls.push('action');
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(Rec, 'r')
  @Middleware(ReplaceData)
  public replaceData() {
    return new Ok({ original: true });
  }

  // entered Rec first, so ReplaceResponse runs its onAfter before Rec's
  @Get()
  @Middleware(ReplaceResponse)
  @Middleware(Rec, 'r')
  public replaceResponse() {
    return new Ok({ original: true });
  }

  @Get()
  @Middleware(Rec, 'r')
  @OnError(Handled, () => new Unauthorized({ handled: true }))
  public onErrorAnswer() {
    throw new Handled('answered by @OnError');
  }

  @Get()
  @Middleware(Rec, 'r')
  public defaultMap() {
    throw new Forbidden('answered by the error map');
  }

  @Get()
  @Middleware(SetHeader)
  public header() {
    return new Ok({});
  }

  @Get()
  @Middleware(SetHeader)
  public headerOnError() {
    throw new Forbidden('nope');
  }

  @Get()
  @Middleware(OverrideHeaders)
  public overridden() {
    return new Ok({}, { Headers: [{ Name: 'X-Version', Value: 'from-action' }, { Name: 'X-Kind', Value: 'from-action' }] });
  }

  @Get()
  @Middleware(Rec, 'r')
  public sentThenThrows(_req: express.Request, res: express.Response) {
    res.status(200).send('sent');
    throw new Forbidden('after the reply');
  }

  @Get()
  public partialThenThrows(_req: express.Request, res: express.Response) {
    res.status(200).write('partial');
    throw new Forbidden('mid-reply');
  }

  @Get()
  @Middleware(Rec, 'late')
  @Middleware(AnswerEarly)
  @Middleware(OuterRec, 'outer')
  public early() {
    calls.push('action');
    return new Ok({ fromAction: true });
  }

  @Get()
  @Middleware(Rec, 'r')
  public async slow() {
    calls.push('action');
    await sleep(400);
    return new Ok({});
  }

  @Get()
  @Middleware(Rec, 'b')
  @Middleware(ThrowAfter, 'thrower')
  @Middleware(Rec, 'a')
  public d8() {
    return new Ok({ ok: true });
  }

  // entry order second, first, a: onAfter runs a, first, second
  @Get()
  @Middleware(Rec, 'a')
  @Middleware(ThrowAfter, 'first')
  @Middleware(ThrowAfter, 'second')
  public d8Twice() {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(AlsProbe)
  public als() {
    (this._actionLocalStorage.getStore() as unknown as Record<string, unknown>).marker = 'set-by-action';
    return new Ok({});
  }

  @Get()
  @Middleware(Rec, 'r')
  public raw(_req: express.Request, res: express.Response) {
    res.status(200).send('written by the action');
  }

  @Get()
  @Middleware(Rec, 'b')
  @Middleware(ThrowBefore)
  @Middleware(Rec, 'a')
  public refused() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(CtxProbe)
  public ctx() {
    return new Ok({});
  }

  // entry: SlowBefore, then FinishOnly
  @Get()
  @Middleware(FinishOnly)
  @Middleware(SlowBefore)
  public lateFinish() {
    calls.push('action');
    return new Ok({});
  }

  // entry: ThrowAfter, then CachePublic: CachePublic's onAfter runs first, on the success reply
  @Get()
  @Middleware(CachePublic)
  @Middleware(ThrowAfter, 'thrower')
  public d8Cache() {
    return new Ok({});
  }

  @Get()
  @Middleware(SameHeader)
  public sameHeader() {
    return new Ok({}, { Headers: [{ Name: 'X-V', Value: 'response' }] });
  }

  // entry: AlsProbe, then RefuseBefore
  @Get()
  @Middleware(RefuseBefore)
  @Middleware(AlsProbe)
  public alsOnError() {
    return new Ok({});
  }
}

/** Sends a GET and drops the connection after `ms`, before any answer. */
function abandon(path: string, ms: number): void {
  const request = http.request({ host: 'localhost', port: appPort(), path: `/${path}`, method: 'GET', headers: { Accept: 'application/json' } });
  request.on('error', () => {});
  request.end();
  setTimeout(() => request.destroy(), ms);
}

describe('Route middleware context hooks', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(HooksController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(state)) delete state[key];
  });

  afterEach(() => {
    sinon.restore();
  });

  it('gives onBefore the route, the controller, the mounted path and the request store', async () => {
    await req().get('hooks/ctx').set('Accept', 'application/json');

    expect(state.beforeCtx).to.deep.eq({ route: 'ctx', controller: 'HooksController', path: 'http:GET /hooks/ctx', storage: true });
  });

  it('runs onAfter inner first and onFinish after the response, outer stage respected', async () => {
    const res = await req().get('hooks/ok').set('Accept', 'application/json');
    await until(() => calls.length === 10);

    expect(res.status).to.eq(200);
    expect(calls).to.deep.eq([
      'outer:before',
      'i1:before',
      'i2:before',
      'action',
      'i2:after:200:-',
      'i1:after:200:-',
      'outer:after:200:-',
      'i2:finish:false',
      'i1:finish:false',
      'outer:finish:false',
    ]);
  });

  it('lets onAfter replace the data of the reply', async () => {
    const res = await req().get('hooks/replaceData').set('Accept', 'application/json');

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ replaced: true, was: { original: true } });
  });

  it('lets onAfter replace the reply; the hooks after it see the replacement', async () => {
    const res = await req().get('hooks/replaceResponse').set('Accept', 'application/json');

    expect(res.status).to.eq(201);
    expect(res.body).to.deep.eq({ replacement: true });
    expect(calls).to.include('r:after:201:-');
  });

  it('runs onAfter on the error reply of an @OnError handler, with ctx.error', async () => {
    const res = await req().get('hooks/onErrorAnswer').set('Accept', 'application/json');

    expect(res.status).to.eq(401);
    expect(calls).to.include('r:after:401:Handled');
  });

  it('runs onAfter on the error reply of the error map, with ctx.error', async () => {
    const res = await req().get('hooks/defaultMap').set('Accept', 'application/json');

    expect(res.status).to.eq(403);
    expect(calls).to.include('r:after:403:Forbidden');
  });

  it('sends a header set by onAfter, on a success and on an error reply', async () => {
    const ok = await req().get('hooks/header').set('Accept', 'application/json');
    const failed = await req().get('hooks/headerOnError').set('Accept', 'application/json');

    expect(ok.header['x-after']).to.eq('200');
    expect(failed.status).to.eq(403);
    expect(failed.header['x-after']).to.eq('403');
  });

  it('lets a header set in onAfter, on ctx.res or on ctx.response, win over the response options', async () => {
    const res = await req().get('hooks/overridden').set('Accept', 'application/json');

    expect(res.header['x-version']).to.eq('from-res');
    expect(res.header['x-kind']).to.eq('from-response');
  });

  it('logs an error raised after the action sent its reply, without a second reply or an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const error = sinon.spy(DI.resolve(Log, ['http']), 'error');
    try {
      const res = await req().get('hooks/sentThenThrows');
      await sleep(50);

      expect(res.status).to.eq(200);
      expect(res.text).to.eq('sent');
      expect(calls).to.deep.eq(['r:before', 'r:finish:false']);
      expect(error.getCalls().some((c) => (c.args[0] as { error?: Error } | undefined)?.error?.message === 'after the reply')).to.eq(true);
      expect(unhandled).to.deep.eq([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('drops the connection of a reply cut short by an error', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const request = http.request({ host: 'localhost', port: appPort(), path: '/hooks/partialThenThrows', method: 'GET' }, (response) => {
        response.on('data', () => {});
        response.on('end', () => resolve('ended'));
        response.on('error', () => resolve('cut'));
        response.on('aborted', () => resolve('cut'));
      });
      request.on('error', () => resolve('cut'));
      request.end();
    });

    expect(outcome).to.eq('cut');
  });

  it('answers with the Response an onBefore returned: no later middleware, no action; entered ones see it', async () => {
    const res = await req().get('hooks/early').set('Accept', 'application/json');
    await until(() => calls.includes('outer:finish:false'));

    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ early: true });
    expect(calls).to.deep.eq(['outer:before', 'answer:before', 'answer:after:200:-', 'outer:after:200:-', 'outer:finish:false']);
  });

  it('runs onFinish with aborted: true when the client went away', async () => {
    abandon('hooks/slow', 100);
    await until(() => calls.some((c) => c.startsWith('r:finish')));
    await sleep(400);

    expect(calls).to.include('r:finish:true');
    expect(calls.filter((c) => c.startsWith('r:finish'))).to.have.length(1);
  });

  it('turns a throwing onAfter into the error reply: earlier hooks are not re-run, later ones see the error reply', async () => {
    const res = await req().get('hooks/d8').set('Accept', 'application/json');
    await until(() => calls.includes('a:finish:false'));

    expect(res.status).to.eq(403);
    expect(calls).to.deep.eq(['a:before', 'b:before', 'b:after:200:-', 'thrower:after:200:-', 'a:after:403:Forbidden', 'b:finish:false', 'a:finish:false']);
  });

  it('logs a throw on the error reply a throwing onAfter produced, and sends that reply', async () => {
    const error = sinon.spy(DI.resolve(Log, ['http']), 'error');

    const res = await req().get('hooks/d8Twice').set('Accept', 'application/json');
    await until(() => calls.includes('a:finish:false'));

    expect(res.status).to.eq(403);
    expect(JSON.stringify(res.body)).to.contain('first refused the reply');
    expect(calls).to.deep.eq(['a:before', 'a:after:200:-', 'first:after:200:-', 'second:after:403:Forbidden', 'a:finish:false']);
    expect(error.getCalls().some((c) => (c.args[0] as { error?: Error } | undefined)?.error?.message === 'second refused the reply')).to.eq(true);
  });

  it('runs onAfter inside the AsyncLocalStorage context the action ran in', async () => {
    await req().get('hooks/als').set('Accept', 'application/json');

    expect(state.afterStore).to.eq(true);
    expect(state.afterMarker).to.eq('set-by-action');
  });

  it('skips onAfter for an action that wrote res itself; onFinish still runs', async () => {
    const res = await req().get('hooks/raw');
    await until(() => calls.includes('r:finish:false'));

    expect(res.status).to.eq(200);
    expect(res.text).to.eq('written by the action');
    expect(calls).to.deep.eq(['r:before', 'r:finish:false']);
  });

  it('runs onFinish once, aborted, for a middleware entered after the client left', async () => {
    abandon('hooks/lateFinish', 100);
    await until(() => calls.some((c) => c.startsWith('finish-only')));
    await sleep(200);

    expect(calls).to.deep.eq(['action', 'finish-only:true']);
  });

  it('sends the error reply of a throwing onAfter without the headers earlier hooks set for the success reply', async () => {
    const res = await req().get('hooks/d8Cache').set('Accept', 'application/json');

    expect(res.status).to.eq(403);
    expect(res.header['cache-control']).to.not.match(/public/);
  });

  it('lets a header an onAfter sets win over the response options even when the value did not change', async () => {
    const res = await req().get('hooks/sameHeader').set('Accept', 'application/json');

    expect(res.header['x-v']).to.eq('hook');
  });

  it('runs onAfter of an error reply inside the AsyncLocalStorage context too', async () => {
    const res = await req().get('hooks/alsOnError').set('Accept', 'application/json');

    expect(res.status).to.eq(400);
    expect(state.afterStore).to.eq(true);
  });

  it('gives no onAfter or onFinish to a middleware the chain never entered', async () => {
    const res = await req().get('hooks/refused').set('Accept', 'application/json');
    await until(() => calls.includes('a:finish:false'));

    expect(res.status).to.eq(400);
    expect(calls).to.deep.eq(['a:before', 'a:after:400:InvalidArgument', 'a:finish:false']);
  });
});
