import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Intl } from '@spinajs/intl';
import { NewInstance } from '@spinajs/di';
import { CodedHttpException, UnexpectedServerError } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log';
import type { TestApp } from '@spinajs/testing';
import type express from 'express';

import { appPort, httpApp, req } from './common.js';
import { AroundMiddleware, BaseController, BasePath, Controllers, Get, HttpServer, Middleware, Ok, OnError, Req, Response, RouteClientGone, RouteMiddleware, RouteRegistrationException, Unauthorized, buildRouteHandlers } from '../src/index.js';
import type { ControllerActionHost, IActionLocalStoregeContext, IController, IRoute, IRouteChainOptions, IRouteInvocation, IRouteOutcome, MiddlewareStage, Request } from '../src/index.js';
import { createAroundHandler } from '../src/around.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => (resolve = _resolve));
  return { promise, resolve };
}

const calls: string[] = [];
const state: Record<string, unknown> = {};
const registered: string[] = [];
/** What `proceed()` settled with in the last request: an outcome, or the rejection. */
let settled = deferred<unknown>();

const bag = (storage: IActionLocalStoregeContext | undefined) => storage as unknown as Record<string, unknown> | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Crash extends Error {
  public readonly crash = true;
}
class Plain extends Error {}
class Mapped extends Error {}
class Handled extends Error {}
class Boom extends Error {}

class ExplodingReply extends Ok {
  public override async execute(): ReturnType<Response['execute']> {
    throw new Boom('response step');
  }
}

class InnerProbe extends RouteMiddleware {
  public isEnabled() {
    return true;
  }

  public async onBefore(req: express.Request, res: express.Response) {
    calls.push('inner');
    state.innerX = bag((req as Request).storage)?.x;
    state.innerY = res.locals.y;
  }

  public async onResponse() {}

  public async onAfter() {}
}

class OwnAnswer extends AroundMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onAround({ res }: IRouteInvocation) {
    calls.push('own-answer');
    res.status(202).json({ own: true });
  }
}

class Observer extends AroundMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onAround(inv: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) {
    calls.push('observer');
    state.sameStorage = inv.storage === (inv.req as Request).storage;
    bag(inv.storage)!.x = 'from-storage';
    inv.res.locals.y = 'from-locals';
    try {
      const outcome = await proceed();
      state.upstreamZ = bag(inv.storage)?.z;
      settled.resolve(outcome);
    } catch (err) {
      settled.resolve(err);
    }
  }
}

/** Calls proceed() only after the client went away. */
class LateProceed extends AroundMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onAround({ res }: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) {
    await new Promise((resolve) => res.once('close', resolve));
    try {
      settled.resolve(await proceed());
    } catch (err) {
      settled.resolve(err);
    }
  }
}

@NewInstance()
class Nest extends AroundMiddleware {
  constructor(private readonly label: string) {
    super();
  }

  public async onAround(_inv: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) {
    calls.push(this.label);
    const outcome = await proceed();
    calls.push(`${this.label}:after:${outcome.reply?.status}`);
  }
}

class Twice extends AroundMiddleware {
  public async onAround(_inv: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) {
    await proceed();
    try {
      await proceed();
      settled.resolve('resolved twice');
    } catch (err) {
      settled.resolve(err);
    }
  }
}

class Registering extends AroundMiddleware {
  public onRegister(route: IRoute, path: string) {
    registered.push(`${String(route.Method)} ${path}`);
  }

  public async onAround(_inv: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) {
    await proceed();
  }
}

class DisabledRegistering extends AroundMiddleware {
  public override isEnabled() {
    return false;
  }

  public onRegister() {
    registered.push('disabled');
  }

  public async onAround() {}
}

// decorators apply bottom-up: InnerProbe is declared before the outer middleware above it
@BasePath('around')
class AroundController extends BaseController {
  @Get()
  @Middleware(OwnAnswer)
  @Middleware(InnerProbe)
  public ownAnswer() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(Observer)
  @Middleware(InnerProbe)
  public ok(@Req() req: Request) {
    calls.push('action');
    state.actionX = bag(req.storage)?.x;
    state.actionAlsX = bag(this._actionLocalStorage.getStore())?.x;
    bag(req.storage)!.z = 'from-action';
    return new Ok({ a: 1 });
  }

  @Get()
  @Middleware(Observer)
  @OnError(Handled, (_err, ctx) => {
    state.onErrorX = bag(ctx.req.storage)?.x;
    state.onErrorY = ctx.res.locals.y;
    return new Unauthorized({ handled: true });
  })
  public answered() {
    throw new Handled('answered by @OnError');
  }

  @Get()
  @Middleware(Observer)
  public coded() {
    throw new CodedHttpException(404, 'around.missing', 'No such thing');
  }

  @Get()
  @Middleware(Observer)
  public explodingReply() {
    return new ExplodingReply({});
  }

  @Get()
  @Middleware(Observer)
  @OnError(Crash, () => new Mapped('mapped'))
  public crash() {
    throw new Crash('dead');
  }

  @Get()
  @Middleware(Observer)
  @OnError(Plain, () => new Mapped('mapped'))
  public plain() {
    throw new Plain('plain');
  }

  @Get()
  @Middleware(LateProceed)
  public late() {
    calls.push('action');
    return new Ok({});
  }

  @Get()
  @Middleware(Observer)
  public async slow() {
    calls.push('action');
    await sleep(400);
    return new Ok({});
  }

  @Get()
  @Middleware(Twice)
  public twice() {
    return new Ok({});
  }

  @Get()
  @Middleware(Registering)
  @Middleware(DisabledRegistering)
  public registered() {
    return new Ok({});
  }
}

@BasePath('nest')
@Middleware(Nest, 'A')
class NestController extends BaseController {
  @Get()
  @Middleware(Nest, 'B')
  public probe() {
    calls.push('action');
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

describe('Around middlewares', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => {
        c.register(AroundController).as(BaseController);
        c.register(NestController).as(BaseController);
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
    for (const key of Object.keys(state)) delete state[key];
    settled = deferred<unknown>();
  });

  it('lets an outer middleware that never calls proceed() answer alone', async () => {
    const res = await req().get('around/ownAnswer').set('Accept', 'application/json');

    expect(res.status).to.eq(202);
    expect(res.body).to.deep.eq({ own: true });
    expect(calls).to.deep.eq(['own-answer']);
  });

  it('resolves proceed() with the JSON reply of a 2xx answer', async () => {
    const res = await req().get('around/ok').set('Accept', 'application/json');
    const outcome = (await settled.promise) as IRouteOutcome;

    expect(res.status).to.eq(200);
    expect(outcome.reply).to.deep.include({ status: 200, body: res.text });
    expect(outcome).to.not.have.property('error');
    expect(calls).to.deep.eq(['observer', 'inner', 'action']);
  });

  it('resolves proceed() with the reply and the error of an error answered by @OnError', async () => {
    const res = await req().get('around/answered').set('Accept', 'application/json');
    const outcome = (await settled.promise) as IRouteOutcome;

    expect(res.status).to.eq(401);
    expect(outcome.reply).to.deep.include({ status: 401, body: res.text });
    expect(outcome.error).to.be.instanceOf(Handled);
  });

  it('sets outcome.error when the chain threw', async () => {
    const res = await req().get('around/coded').set('Accept', 'application/json');
    const outcome = (await settled.promise) as IRouteOutcome;

    expect(res.status).to.eq(404);
    expect(outcome.reply?.status).to.eq(404);
    expect(outcome.error).to.be.instanceOf(CodedHttpException);
  });

  it('records an error thrown by the response step itself', async () => {
    const res = await req().get('around/explodingReply').set('Accept', 'application/json');
    const outcome = (await settled.promise) as IRouteOutcome;

    expect(res.status).to.eq(500);
    expect(outcome.error).to.be.instanceOf(Boom);
  });

  it('keeps a crash: true error recorded when an error handler turns it into another error', async () => {
    const res = await req().get('around/crash').set('Accept', 'application/json');
    const outcome = (await settled.promise) as IRouteOutcome;

    expect(res.status).to.eq(500);
    expect(outcome.error).to.be.instanceOf(Crash);
  });

  it('records the error an error handler turned a plain error into', async () => {
    await req().get('around/plain').set('Accept', 'application/json');
    const outcome = (await settled.promise) as IRouteOutcome;

    expect(outcome.error).to.be.instanceOf(Mapped);
  });

  it('rejects proceed() with beforeRoute: true when the client went away before it, and never runs the route', async () => {
    abandon('around/late', 100);
    const rejection = await settled.promise;
    await sleep(100);

    expect(rejection).to.be.instanceOf(RouteClientGone);
    expect((rejection as RouteClientGone).beforeRoute).to.eq(true);
    expect(calls).to.deep.eq([]);
  });

  it('rejects proceed() with beforeRoute: false when the client went away mid-route', async () => {
    abandon('around/slow', 100);
    const rejection = await settled.promise;

    expect(rejection).to.be.instanceOf(RouteClientGone);
    expect((rejection as RouteClientGone).beforeRoute).to.eq(false);
    expect(calls).to.deep.eq(['observer', 'action']);
  });

  it('nests two around middlewares in declaration order', async () => {
    const res = await req().get('nest/probe').set('Accept', 'application/json');
    await sleep(20);

    expect(res.status).to.eq(200);
    expect(calls).to.deep.eq(['A', 'B', 'action', 'B:after:200', 'A:after:200']);
  });

  it('rejects a second proceed() call', async () => {
    const res = await req().get('around/twice').set('Accept', 'application/json');
    const second = await settled.promise;

    expect(res.status).to.eq(200);
    expect(second).to.be.instanceOf(Error);
    expect((second as Error).message).to.match(/Twice.*proceed\(\) more than once/);
  });

  it('calls onRegister once at mount with the mounted path, for enabled middlewares only', () => {
    expect(registered).to.deep.eq(['registered /around/registered']);
  });

  describe('state', () => {
    it('shows what an outer middleware wrote before proceed() to the inner middlewares and the action', async () => {
      await req().get('around/ok').set('Accept', 'application/json');
      await settled.promise;

      expect(state).to.deep.include({ innerX: 'from-storage', innerY: 'from-locals', actionX: 'from-storage', actionAlsX: 'from-storage' });
    });

    it('shows it to an @OnError handler', async () => {
      await req().get('around/answered').set('Accept', 'application/json');
      await settled.promise;

      expect(state).to.deep.include({ onErrorX: 'from-storage', onErrorY: 'from-locals' });
    });

    it('shows the outer middleware what the action wrote, through the request store itself', async () => {
      await req().get('around/ok').set('Accept', 'application/json');
      await settled.promise;

      expect(state).to.deep.include({ upstreamZ: 'from-action', sameStorage: true });
    });
  });
});

describe('Around middleware handler', () => {
  const log = { error: () => {}, warn: () => {}, trace: () => {} } as unknown as Log;
  const route = { Method: 'probe', Type: 'get' } as unknown as IRoute;
  const controller = {} as IController;

  class Probe extends AroundMiddleware {
    constructor(public around: (inv: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) => Promise<void>) {
      super();
    }

    public onAround(inv: IRouteInvocation, proceed: () => Promise<IRouteOutcome>) {
      return this.around(inv, proceed);
    }
  }

  function fakeRes() {
    return Object.assign(new EventEmitter(), { locals: {}, headersSent: false, writableEnded: false, destroyed: false, closed: false }) as unknown as express.Response;
  }

  const listeners = (res: express.Response) => res.listenerCount('close') + res.listenerCount('finish');

  function run(around: Probe['around'], next: (res: express.Response, err?: unknown) => void) {
    const res = fakeRes();
    const done = deferred<unknown>();
    const handler = createAroundHandler(
      new Probe(async (inv, proceed) => {
        try {
          await around(inv, proceed);
          done.resolve('done');
        } catch (err) {
          done.resolve(err);
        }
      }),
      route,
      controller,
      'http:GET /probe',
      log,
    );
    handler({ storage: {} } as unknown as express.Request, res, ((err?: unknown) => next(res, err)) as express.NextFunction);
    return { res, done: done.promise };
  }

  it('removes its listeners once the response finished', async () => {
    let outcome: IRouteOutcome | undefined;
    const { res, done } = run(
      async (_inv, proceed) => {
        outcome = await proceed();
      },
      (r) => setImmediate(() => r.emit('finish')),
    );

    expect(await done).to.eq('done');
    expect(outcome).to.deep.eq({ reply: null });
    expect(listeners(res)).to.eq(0);
  });

  it('removes its listeners when the client went away mid-route', async () => {
    const { res, done } = run(
      async (_inv, proceed) => {
        await proceed();
      },
      (r) => setImmediate(() => r.emit('close')),
    );

    const err = await done;
    expect(err).to.be.instanceOf(RouteClientGone);
    expect((err as RouteClientGone).beforeRoute).to.eq(false);
    expect(listeners(res)).to.eq(0);
  });

  it('removes its listeners, and answers 500, when onAround neither proceeds nor answers', async () => {
    let forwarded: unknown;
    const { res, done } = run(
      async () => {},
      (_r, err) => (forwarded = err),
    );

    expect(await done).to.eq('done');
    await sleep(0);
    expect(listeners(res)).to.eq(0);
    expect(forwarded).to.be.instanceOf(UnexpectedServerError);
  });

  it('rejects a second proceed() without running the chain again', async () => {
    let nexts = 0;
    const { done } = run(
      async (_inv, proceed) => {
        await proceed();
        await proceed();
      },
      (r) => {
        nexts++;
        setImmediate(() => r.emit('finish'));
      },
    );

    const err = await done;
    expect(err).to.be.instanceOf(Error);
    expect((err as Error).message).to.match(/proceed\(\) more than once/);
    expect(nexts).to.eq(1);
  });
});

describe('Around middleware registration', () => {
  class FailingRegister extends AroundMiddleware {
    public onRegister() {
      throw new Error('missing peer');
    }

    public async onAround() {}
  }

  const chain = (middlewares: RouteMiddleware[]): IRouteChainOptions =>
    ({
      controller: {} as ControllerActionHost,
      route: { Method: 'probe', Type: 'get' } as unknown as IRoute,
      path: '/x/probe',
      basePath: 'x',
      middlewares,
    } as IRouteChainOptions);

  it('fails the route registration with RouteRegistrationException naming the middleware and the route', async () => {
    let error: unknown;
    try {
      await buildRouteHandlers(chain([new FailingRegister()]));
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(RouteRegistrationException);
    for (const part of ['FailingRegister', 'http:GET /x/probe', 'missing peer']) expect((error as Error).message).to.contain(part);
  });
});
