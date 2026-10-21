import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Schema } from '@spinajs/validation';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, BasePolicy, Body, Controllers, HttpServer, Middleware, Ok, Policy, Post, RouteMiddleware } from '../src/index.js';

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

@BasePath('order')
class PipelineOrderController extends BaseController {
  @Post()
  @Policy(RecordingPolicy)
  @Middleware(RecordingMiddleware)
  public probe(@Body() input: ProbeInput) {
    calls.push('action');
    return new Ok({ input });
  }
}

describe('Route pipeline order', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    DI.register(TestConfiguration).as(Configuration);
    DI.register(PipelineOrderController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(PipelineOrderController);
    DI.uncache(PipelineOrderController);
    DI.uncache(BaseController);
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
});
