import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { Schema } from '@spinajs/validation';

import { httpApp, req } from './common.js';
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Body, Controllers, HttpServer, Middleware, NoContent, Ok, OnError, Policy, Post, RouteMiddleware } from '../src/index.js';
import type { ErrorStage, IReplyContext, MiddlewareStage } from '../src/index.js';
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
}

class DenyingPolicy extends BasePolicy {
  public isEnabled() {
    return true;
  }

  public async execute() {
    calls.push('policy');
    throw new Forbidden('denied');
  }
}

class BeforePolicyMiddleware extends RouteMiddleware {
  public readonly Stage: MiddlewareStage = 'beforePolicy';

  public async onBefore() {
    calls.push('beforePolicy');
  }

  public async onAfter({ error }: IReplyContext) {
    calls.push(`beforePolicy:after:${(error as Error | undefined)?.constructor.name ?? 'none'}`);
  }

  public onFinish() {
    calls.push('beforePolicy:finish');
  }
}

class BeforePolicyAnswer extends RouteMiddleware {
  public readonly Stage: MiddlewareStage = 'beforePolicy';

  public async onBefore() {
    calls.push('beforePolicy:answer');
    return new NoContent(null);
  }
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
  @Policy(RecordingPolicy)
  @Middleware(OuterRecordingMiddleware)
  @Middleware(BeforePolicyMiddleware)
  public beforeGate(@Body() input: ProbeInput) {
    calls.push('action');
    return new Ok({ input });
  }

  @Post()
  @Policy(DenyingPolicy)
  @Middleware(OuterRecordingMiddleware)
  @Middleware(BeforePolicyMiddleware)
  public deniedBeforeGate() {
    calls.push('action');
    return new Ok({});
  }

  @Post()
  @Policy(DenyingPolicy)
  @Middleware(BeforePolicyAnswer)
  public answeredBeforeGate() {
    calls.push('action');
    return new Ok({});
  }

  @Post()
  @Policy(RecordingPolicy)
  @Middleware(BeforePolicyAnswer)
  public answeredBeforeAllowingGate() {
    calls.push('action');
    return new Ok({});
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

  it('runs a beforePolicy middleware before the policy gate and the outer middlewares', async () => {
    const res = await req().post('order/beforeGate').send({ a: 'x' });
    expect(res.status).to.eq(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).to.deep.eq(['beforePolicy', 'policy', 'outer', 'action', 'outer:after', 'beforePolicy:after:none', 'beforePolicy:finish']);
  });

  it('gives a beforePolicy middleware the onAfter and onFinish of a policy refusal; the later ones are not entered', async () => {
    const res = await req().post('order/deniedBeforeGate').send({});
    expect(res.status).to.eq(403);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).to.deep.eq(['beforePolicy', 'policy', 'beforePolicy:after:Forbidden', 'beforePolicy:finish']);
  });

  it('runs the policy gate after a beforePolicy answer: a refusal replaces the answer', async () => {
    const res = await req().post('order/answeredBeforeGate').send({});
    expect(res.status).to.eq(403);
    expect(calls).to.deep.eq(['beforePolicy:answer', 'policy']);
  });

  it('sends a beforePolicy answer once the policies allow the request, without running the action', async () => {
    const res = await req().post('order/answeredBeforeAllowingGate').send({});
    expect(res.status).to.eq(204);
    expect(calls).to.deep.eq(['beforePolicy:answer', 'policy']);
  });
});
