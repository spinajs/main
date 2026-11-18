import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { NewInstance } from '@spinajs/di';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { appPort, httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Deadline, Get, HttpServer, Middleware, Ok, RouteClientGone, RouteMiddleware } from '../src/index.js';
import type { IFinishContext, IMiddlewareContext, IRouteOutcome, Response } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const calls: string[] = [];
const settlements: { label: string; aborted: boolean; error?: unknown; promise: Promise<unknown> }[] = [];

const errorName = (error: unknown) => (error === undefined ? '-' : (error as Error).constructor.name);

async function recordSettled(label: string, ctx: IFinishContext): Promise<void> {
  const settled = await ctx.settled;
  settlements.push({ label, aborted: ctx.aborted, promise: ctx.settled, ...settled });
  calls.push(`${label}:settled:${errorName(settled.error)}`);
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms; calls: ${calls.join(', ')}`);
    await sleep(5);
  }
}

/** Records `<label>:finish:<aborted>` when onFinish runs and `<label>:settled:<error class>` once `settled` resolved. */
@NewInstance()
class Watch extends RouteMiddleware {
  constructor(protected readonly label: string = 'w') {
    super();
  }

  public onFinish(ctx: IFinishContext): void {
    calls.push(`${this.label}:finish:${ctx.aborted}`);
    void recordSettled(this.label, ctx);
  }
}

class Refuse extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    throw new InvalidArgument('refused');
  }
}

class SlowRefuse extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    await sleep(300);
    throw new InvalidArgument('refused late');
  }
}

class SlowBefore extends RouteMiddleware {
  public async onBefore(): Promise<void> {
    await sleep(300);
  }
}

class AnswerEarly extends RouteMiddleware {
  public async onBefore(): Promise<Response> {
    return new Ok({ early: true });
  }
}

class SlowAround extends RouteMiddleware {
  public async onAround(_ctx: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    await sleep(300);
    await proceed();
  }

  public onFinish(ctx: IFinishContext): void {
    void recordSettled('around', ctx);
  }
}

@BasePath('settled')
class SettledController extends BaseController {
  @Get()
  @Middleware(Watch)
  public ok() {
    calls.push('action');
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(Watch)
  public throws() {
    throw new Forbidden('thrown by the action');
  }

  @Get()
  @Middleware(Watch)
  public async slow() {
    await sleep(400);
    calls.push('action:done');
    return new Ok({});
  }

  @Get()
  @Middleware(Watch)
  public async slowThrows() {
    await sleep(400);
    calls.push('action:done');
    throw new Forbidden('thrown after the client left');
  }

  @Get()
  @Middleware(Refuse)
  @Middleware(Watch)
  public refused() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(SlowBefore)
  @Middleware(Watch)
  public slowBefore() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(SlowRefuse)
  @Middleware(Watch)
  public slowRefused() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(AnswerEarly)
  @Middleware(Watch)
  public early() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Deadline(100)
  @Middleware(Watch)
  public async pastDeadline() {
    await sleep(400);
    calls.push('action:done');
    return new Ok({});
  }

  @Get()
  @Middleware(SlowAround)
  public aroundGone() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(Watch, 'b')
  @Middleware(Watch, 'a')
  public twoWatchers() {
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

describe('IFinishContext.settled', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(SettledController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    calls.length = 0;
    settlements.length = 0;
  });

  it('settles without an error for an action that returned', async () => {
    const res = await req().get('settled/ok').set('Accept', 'application/json');
    await until(() => calls.includes('w:settled:-'));

    expect(res.status).to.eq(200);
    expect(calls).to.deep.eq(['action', 'w:finish:false', 'w:settled:-']);
    expect(settlements[0]).to.not.have.property('error');
  });

  it('carries the error the action threw', async () => {
    const res = await req().get('settled/throws').set('Accept', 'application/json');
    await until(() => settlements.length === 1);

    expect(res.status).to.eq(403);
    expect(settlements[0].error).to.be.instanceOf(Forbidden);
    expect((settlements[0].error as Error).message).to.eq('thrown by the action');
  });

  it('waits for an action the client left: aborted at once, settled when the action returned', async () => {
    abandon('settled/slow', 100);
    await until(() => calls.includes('w:settled:-'));

    expect(calls).to.deep.eq(['w:finish:true', 'action:done', 'w:settled:-']);
  });

  it('carries the error of an action that threw after the client left', async () => {
    abandon('settled/slowThrows', 100);
    await until(() => settlements.length === 1);

    expect(calls).to.deep.eq(['w:finish:true', 'action:done', 'w:settled:Forbidden']);
    expect(settlements[0]).to.include({ aborted: true });
  });

  it('settles with the refusal for a request refused before the action ran', async () => {
    const res = await req().get('settled/refused').set('Accept', 'application/json');
    await until(() => settlements.length === 1);

    expect(res.status).to.eq(400);
    expect(calls).to.deep.eq(['w:finish:false', 'w:settled:InvalidArgument']);
  });

  it('waits for an action the chain reaches after the client left during an onBefore', async () => {
    abandon('settled/slowBefore', 100);
    await until(() => settlements.length === 1);

    expect(calls).to.deep.eq(['w:finish:true', 'action', 'w:settled:-']);
  });

  it('settles with a refusal that comes after the client left during an onBefore', async () => {
    abandon('settled/slowRefused', 100);
    await until(() => settlements.length === 1);
    await sleep(50);

    expect(calls).to.deep.eq(['w:finish:true', 'w:settled:InvalidArgument']);
  });

  it('settles without an error for an answer an onBefore gave in place of the action', async () => {
    const res = await req().get('settled/early').set('Accept', 'application/json');
    await until(() => settlements.length === 1);

    expect(res.body).to.deep.eq({ early: true });
    expect(calls).to.deep.eq(['w:finish:false', 'w:settled:-']);
  });

  it('waits for the action after a deadline answered 504 in its place', async () => {
    const res = await req().get('settled/pastDeadline').set('Accept', 'application/json');
    expect(res.status).to.eq(504);
    await until(() => settlements.length === 1);

    expect(calls).to.deep.eq(['w:finish:false', 'action:done', 'w:settled:-']);
  });

  it('settles with RouteClientGone when an around middleware could not proceed: the client left first', async () => {
    abandon('settled/aroundGone', 100);
    await until(() => settlements.length === 1);
    await sleep(50);

    expect(calls).to.deep.eq(['around:settled:RouteClientGone']);
    expect(settlements[0].error).to.be.instanceOf(RouteClientGone);
  });

  it('gives every finish hook of the request the same settlement, once', async () => {
    await req().get('settled/twoWatchers').set('Accept', 'application/json');
    await until(() => settlements.length === 2);
    await sleep(50);

    expect(settlements.map((s) => s.label)).to.have.members(['a', 'b']);
    expect(settlements[0].promise).to.eq(settlements[1].promise);
  });
});
