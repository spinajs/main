import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type express from 'express';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';
import { Forbidden } from '@spinajs/exceptions';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { answeredAsServerError, BaseController, BasePath, BasePolicy, Controllers, ErrorObserver, Get, HttpServer, Ok, OnError, Policy, Post, Response, ServerError } from '../src/index.js';
import type { ObservedErrorContext } from '../src/index.js';

interface ISeen {
  error: string;
  status: number;
  sent: boolean;
  serverError: boolean;
  answered: boolean;
  route?: string;
  controller?: string;
  stage?: string;
}

const seen: ISeen[] = [];

class RecordingObserver extends ErrorObserver {
  observe(err: unknown, ctx: ObservedErrorContext): void {
    seen.push({
      error: (err as Error).constructor.name,
      status: ctx.status,
      sent: ctx.sent,
      serverError: answeredAsServerError(err),
      answered: ctx.answer !== undefined,
      route: ctx.route ? String(ctx.route.Method) : undefined,
      controller: ctx.controller?.constructor.name,
      stage: ctx.stage,
    });
  }
}

class RejectingObserver extends ErrorObserver {
  observe(): Promise<void> {
    return Promise.reject(new Error('observer rejected'));
  }
}

class ThrowingObserver extends ErrorObserver {
  observe(): void {
    throw new Error('observer threw');
  }
}

class DenyPolicy extends BasePolicy {
  isEnabled() {
    return true;
  }

  async execute(): Promise<void> {
    throw new Forbidden('nope');
  }
}

class UnsendableAnswer extends Response {
  public async execute(): Promise<void> {
    throw new Error('the answer could not be sent');
  }
}

// Like a piped file answer: headers and a first chunk go out, and a client that leaves mid-transfer means end() is never called.
class StreamedAnswer extends Response {
  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    res.status(503).setHeader('Content-Type', 'text/plain');
    res.write('first chunk');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!res.closed) {
      res.end('rest');
    }
  }
}

@BasePath('observed')
class ObservedController extends BaseController {
  @Get()
  @OnError(Error, () => new StreamedAnswer())
  public streamed() {
    throw new Error('answered with a stream');
  }

  @Get()
  public crash() {
    throw new Error('raised in the action');
  }

  @Get()
  public async slow() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    throw new Error('raised after the client left');
  }

  @Get()
  @OnError(Error, () => new UnsendableAnswer())
  public unsendable() {
    throw new Error('answered by the route');
  }

  @Post()
  public echo() {
    return new Ok({});
  }

  @Get()
  @Policy(DenyPolicy)
  public denied() {
    return new Ok({});
  }

  @Get()
  @OnError(Error, () => new ServerError({ message: 'formatted by the route' }))
  public formatted() {
    throw new Error('answered by the route');
  }

  @Get()
  @OnError(Forbidden, () => new Ok({ handled: true }))
  public handled() {
    throw new Forbidden('answered by the route');
  }
}

/** Waits for `count` observations, then a little longer, so an unexpected second one would be caught too. */
async function observed(count: number): Promise<ISeen[]> {
  for (let i = 0; i < 200 && seen.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return seen;
}

describe('ErrorObserver', function () {
  this.timeout(15000);

  let logError: sinon.SinonSpy;

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(RecordingObserver).as(ErrorObserver);
    // Registered for every test: each status asserted below also shows that a failing observer changed no answer.
    DI.register(RejectingObserver).as(ErrorObserver);
    DI.register(ThrowingObserver).as(ErrorObserver);
    DI.register(ObservedController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
    logError = sinon.spy(DI.resolve(Log, ['http']), 'error');
  });

  after(async () => {
    logError.restore();
    await releaseHttpServer();
    for (const c of [ObservedController, RecordingObserver, RejectingObserver, ThrowingObserver] as Class<unknown>[]) {
      DI.unregister(c);
      DI.uncache(c);
    }
    DI.uncache(BaseController);
    DI.uncache(Configuration);
  });

  beforeEach(() => {
    seen.length = 0;
    logError.resetHistory();
  });

  it('sees an error thrown in a controller action, with its route and status', async () => {
    const res = await req().get('observed/crash');

    expect(res).to.have.status(500);
    expect(await observed(1)).to.deep.equal([{ error: 'Error', status: 500, sent: true, serverError: true, answered: false, route: 'crash', controller: 'ObservedController', stage: 'action' }]);
  });

  it('sees a policy rejection with its stage', async () => {
    const res = await req().get('observed/denied');

    expect(res).to.have.status(403);
    expect(await observed(1)).to.deep.equal([{ error: 'Forbidden', status: 403, sent: true, serverError: false, answered: false, route: 'denied', controller: 'ObservedController', stage: 'policy' }]);
  });

  it('sees an error raised before routing, without a route', async () => {
    const res = await req().post('observed/echo').set('Content-Type', 'application/json').send('{"broken"');

    expect(res).to.have.status(400);
    const [entry, ...more] = await observed(1);
    expect(more).to.be.empty;
    expect(entry).to.include({ status: 400, sent: true, serverError: false, answered: false, route: undefined, controller: undefined, stage: undefined });
  });

  it('sees a request that matches no route', async () => {
    const res = await req().get('observed/nowhere');

    expect(res).to.have.status(404);
    expect(await observed(1)).to.deep.equal([{ error: 'ResourceNotFound', status: 404, sent: true, serverError: false, answered: false, route: undefined, controller: undefined, stage: undefined }]);
  });

  it('sees, once, an error a route handler answered with a 500', async () => {
    const res = await req().get('observed/formatted');

    expect(res).to.have.status(500);
    expect(await observed(1)).to.deep.equal([{ error: 'Error', status: 500, sent: true, serverError: true, answered: true, route: 'formatted', controller: 'ObservedController', stage: 'action' }]);
  });

  it('sees, once, an error a route handler answered with a success', async () => {
    const res = await req().get('observed/handled');

    expect(res).to.have.status(200);
    expect(await observed(1)).to.deep.equal([{ error: 'Forbidden', status: 200, sent: true, serverError: false, answered: true, route: 'handled', controller: 'ObservedController', stage: 'action' }]);
  });

  it('sees, once and with its 500, an error raised after the client left', async () => {
    // The client gives up long before the action throws; the status must still be the one the server chose.
    const left = await req()
      .get('observed/slow')
      .timeout(150)
      .then(
        () => false,
        () => true,
      );

    expect(left).to.equal(true);
    expect(await observed(1)).to.deep.equal([{ error: 'Error', status: 500, sent: false, serverError: true, answered: false, route: 'slow', controller: 'ObservedController', stage: 'action' }]);
  });

  it('sees, once, an answered error whose streamed answer the client aborted after the headers', async () => {
    const left = await req()
      .get('observed/streamed')
      .timeout(150)
      .then(
        () => false,
        () => true,
      );

    expect(left).to.equal(true);
    expect(await observed(1)).to.deep.equal([{ error: 'Error', status: 503, sent: false, serverError: true, answered: true, route: 'streamed', controller: 'ObservedController', stage: 'action' }]);
  });

  it('sees the failure, not the answer, when a route handler answer cannot be sent', async () => {
    const res = await req().get('observed/unsendable');

    expect(res).to.have.status(500);
    const [entry, ...more] = await observed(1);
    expect(more).to.be.empty;
    expect(entry).to.deep.equal({ error: 'Error', status: 500, sent: true, serverError: true, answered: false, route: 'unsendable', controller: 'ObservedController', stage: 'action' });
  });

  it('logs an observer that rejects or throws, and still runs the others', async () => {
    await req().get('observed/crash');
    await observed(1);

    const failures = logError.getCalls().map((call) => (call.args[0] as { observer?: string }).observer);
    expect(failures).to.include.members(['RejectingObserver', 'ThrowingObserver']);
    expect(seen).to.have.lengthOf(1);
  });
});
