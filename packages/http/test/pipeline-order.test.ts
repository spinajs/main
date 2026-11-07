import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { Schema } from '@spinajs/validation';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, BasePolicy, Body, Controllers, HttpServer, Middleware, Ok, OnError, Policy, Post, RouteMiddleware } from '../src/index.js';
import type { ErrorStage, MiddlewareStage } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

const calls: string[] = [];

@Schema({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } })
class ProbeInput {
  public a: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}

class RecordingPolicy extends BasePolicy {
  public isEnabled() {
    return true;
  }

  public async execute() {
    calls.push('policy');
  }
}

class RecordingMiddleware extends RouteMiddleware {
  public isEnabled() {
    return true;
  }

  public async onBefore() {
    calls.push('middleware');
  }

  public async onAfter() {}

  public async onResponse() {}
}

class OuterRecordingMiddleware extends RouteMiddleware {
  public readonly Stage: MiddlewareStage = 'outer';

  public isEnabled() {
    return true;
  }

  public async onBefore() {
    calls.push('outer');
  }

  public async onAfter() {
    calls.push('outer:after');
  }

  public async onResponse() {}
}

class OuterRefusal extends Error {}

let refusalStage: ErrorStage | undefined;

class OuterRefusingMiddleware extends OuterRecordingMiddleware {
  public override async onBefore() {
    throw new OuterRefusal('refused');
  }
}

@BasePath('order')
class PipelineOrderController extends BaseController {
  @Post()
  @Policy(RecordingPolicy)
  @Middleware(RecordingMiddleware)
  public probe(@Body() input: ProbeInput) {
    calls.push('action');
    return new Ok({ input });
  }

  @Post()
  @Policy(RecordingPolicy)
  // decorators apply bottom-up: RecordingMiddleware is declared first
  @Middleware(OuterRecordingMiddleware)
  @Middleware(RecordingMiddleware)
  public staged(@Body() input: ProbeInput) {
    calls.push('action');
    return new Ok({ input });
  }

  @Post()
  @Middleware(OuterRefusingMiddleware)
  @OnError(OuterRefusal, (_err, ctx) => {
    refusalStage = ctx.stage;
    return new Ok({});
  })
  public refusedOuter() {
    return new Ok({});
  }
}

describe('Route pipeline order', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(PipelineOrderController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('runs policies and route middlewares before argument validation', async () => {
    const res = await req().post('order/probe').send({});
    expect(res.status).to.eq(400);
    expect(calls).to.deep.eq(['policy', 'middleware']);
  });

  it('runs the action last on valid input', async () => {
    const res = await req().post('order/probe').send({ a: 'x' });
    expect(res.status).to.eq(200);
    expect(calls).to.deep.eq(['policy', 'middleware', 'action']);
  });

  it('runs outer middlewares right after the policies, before the inner ones declared earlier', async () => {
    const res = await req().post('order/staged').send({ a: 'x' });
    expect(res.status).to.eq(200);
    expect(calls).to.deep.eq(['policy', 'outer', 'middleware', 'action', 'outer:after']);
  });

  it('reports an outer middleware error at the middleware stage', async () => {
    refusalStage = undefined;
    const res = await req().post('order/refusedOuter').send({});
    expect(res.status).to.eq(200);
    expect(refusalStage).to.eq('middleware');
  });
});
